// End-to-end: patched nginx (built by deploy/build-nginx.sh) in front of the
// capture app, driven by headless Chromium.
//   NGINX_BIN=/path/to/sbin/nginx node test/capture.e2e.js
import { chromium } from "playwright";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCaptureApp } from "../server/capture-app.js";
import { openGeo } from "../server/geo.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NGINX = process.env.NGINX_BIN;
if (!NGINX) { console.error("Set NGINX_BIN"); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-"));
execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=localhost",
  "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`], { stdio: "ignore" });
let conf = fs.readFileSync(`${root}/nginx/measure.conf`, "utf8")
  .replaceAll("MEASURE_HOST", "localhost")
  .replace("/var/log/nginx-measure/error.log", `${dir}/error.log`)
  .replace("/run/nginx-measure.pid", `${dir}/nginx.pid`)
  .replace("/var/log/nginx-measure/fingerprints.log", `${dir}/fp.log`)
  .replaceAll("/etc/nginx-measure/fp-headers.conf", `${root}/nginx/fp-headers.conf`)
  .replace("/etc/letsencrypt/live/localhost/fullchain.pem", `${dir}/c.pem`)
  .replace("/etc/letsencrypt/live/localhost/privkey.pem", `${dir}/k.pem`)
  .replace(/listen 80;\n\s*listen \[::\]:80;/, "listen 127.0.0.1:18080;")
  .replace(/listen 443 ssl;\n\s*listen \[::\]:443 ssl;/, "listen 127.0.0.1:18443 ssl;")
  .replace("server 127.0.0.1:3000;", "server 127.0.0.1:13000;")
  .replace("worker_processes auto;", "worker_processes 1;\ndaemon on;");
fs.writeFileSync(`${dir}/nginx.conf`, conf);
const t = spawnSync(NGINX, ["-t", "-c", `${dir}/nginx.conf`, "-p", dir], { encoding: "utf8" });
if (t.status !== 0) { console.error(t.stderr); process.exit(1); }
spawnSync(NGINX, ["-c", `${dir}/nginx.conf`, "-p", dir]);

// Optional: GEO_TEST_DIR with GeoLite2-City.mmdb / dbip-city-lite.mmdb etc.
const geo = process.env.GEO_TEST_DIR ? await openGeo({ dir: process.env.GEO_TEST_DIR, checkEveryMs: 0 }) : null;
const { app, store, attachWebSocket } = createCaptureApp({ adminToken: "test-token", dbPath: `${dir}/visits.db`, geo,
  serverLocation: { lat: 50.11, lon: 8.68 }, botIpsFile: `${dir}/none.json`,
  publicOrigin: "https://localhost:18443", stunUrl: "", allowedHosts: "www.youtube.com,localhost" });
const server = app.listen(13000, "127.0.0.1");
attachWebSocket(server);

const base = "https://localhost:18443";
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { authorization: "Bearer test-token", "content-type": "application/json", ...(init.headers || {}) } });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const results = [];
const check = (name, ok, info = "") => results.push([ok ? "PASS" : "FAIL", name, info]);

try {
  // Allowlist
  const bad = await api("/api/links", { method: "POST", body: JSON.stringify({ url: "https://evil.example/x" }) });
  check("non-allowlisted destination rejected", bad.status === 400);
  const unauth = await fetch(base + "/api/links", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("link creation needs the admin token", unauth.status === 401);
  const link = await (await api("/api/links", { method: "POST", body: JSON.stringify({ url: "https://localhost:18443/api/whoami?destination=1", cohort: "C4", tool: "playwright-headless" }) })).json();
  check("allowlisted link created", !!link.id, link.short);

  // Forged fingerprint headers from the client must be overwritten by nginx
  const who = await (await fetch(base + "/api/whoami", { headers: { "X-JA4": "forged", "X-SYN-TTL": "1" } })).json();
  check("nginx overwrites forged X-JA4", who.ja4 && who.ja4 !== "forged", who.ja4);
  check("SYN TTL captured", who.synTtl === 64, `ttl=${who.synTtl} hops=${who.synHops}`);
  check("JA4T captured", !!who.ja4t, who.ja4t);
  check("TCP RTT captured", Number.isFinite(who.tcpRttUs), `${who.tcpRttUs} us`);

  // Browser run through the stop page
  // --ignore-certificate-errors lets the self-signed test cert register CreepJS's
  // service worker; ignoreHTTPSErrors alone does not cover worker scripts.
  const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  const external = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (/^(https?|wss?):$/.test(u.protocol) && u.hostname !== "localhost") external.push(r.url()); });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("[console]", m.text()));
  page.on("requestfailed", (r) => console.log("[requestfailed]", r.url(), r.failure()?.errorText));
  page.on("framenavigated", (f) => f === page.mainFrame() && console.log("[nav]", f.url()));
  await page.goto(`${base}/r/${link.id}`);
  await page.waitForTimeout(3500); // checks + RTT pings
  await page.click("#continue");
  await page.waitForURL("**/api/whoami?destination=1", { timeout: 10000 });
  check("forwarded to destination", page.url().endsWith("/api/whoami?destination=1"));
  check("stop page and probes contact no other site", external.length === 0, external.slice(0, 3).join(" "));
  await browser.close();
  await new Promise((r) => setTimeout(r, 500));

  const [v] = store.list(1);
  const flagIds = (v.verdict?.flags || []).map((f) => f.id);
  check("timeline T0..T5 recorded", v.t0 && v.t1 && v.t3 && v.t5 && v.t0 <= v.t1 && v.t1 <= v.t5, JSON.stringify({ t1: v.t1 - v.t0, t3: v.t3 - v.t0, t5: v.t5 - v.t0 }));
  check("server fields recorded", !!(v.server.ja4 && v.server.ja4h && v.server.ja4t), v.server.ja4);
  check("10 in-page RTT samples", v.rtt?.samplesMs?.length === 10, JSON.stringify(v.verdict.hop));
  check("behaviour recorded", v.client?.behaviour?.click != null, JSON.stringify(v.client?.behaviour));
  check("headless automation flagged as suspected agent", v.verdict.suspectedAgent === true, `agentScore=${v.verdict.agentScore}`);
  check("macOS UA on Linux flagged (cross-layer)", flagIds.some((id) => /X1|X3|J10|ua-vs/.test(id)));
  check("J10 catches macOS UA on a Linux font set", flagIds.some((id) => id.startsWith("J10-")), JSON.stringify(v.client?.raw?.fonts));
  const cr = v.client?.raw?.creep;
  check("CreepJS-based probes ran (stable ID, worker scope)", !!(cr && !cr.error && cr.fpId && cr.worker),
    cr ? `fpId ${String(cr.fpId).slice(0, 12)}, ${cr.ms} ms, worker ${cr.worker?.type}, lies ${cr.lies?.total}` : "missing");
  check("headless Chromium caught by a C-series probe", flagIds.some((id) => /^C[0-9]+-/.test(id) && id !== "C0-probes-failed"),
    flagIds.filter((id) => /^C/.test(id)).join(","));
  check("FingerprintJS visitor ID recorded", /^[0-9a-f]{20,}$/.test(v.client?.raw?.fpjs?.visitorId || ""), JSON.stringify(v.client?.raw?.fpjs));
  check("verdict carries device IDs", !!(v.verdict.ids?.creep && v.verdict.ids?.fpjs), JSON.stringify(v.verdict.ids));
  check("localhost visit marked private, not geolocated", !geo || v.server.geo?.private === true);
  if (process.env.MODEL_FILE) check("model percentages on the live verdict", !!v.verdict.model?.probabilities,
    JSON.stringify(v.verdict.model));

  // A naive anti-detect profile: page-level getter and canvas patches, the way
  // simple spoofing extensions do it. The page checks and CreepJS should both see it.
  const link2 = await (await api("/api/links", { method: "POST", body: JSON.stringify({ url: "https://localhost:18443/api/whoami?destination=2", cohort: "C6", tool: "init-script-spoof" }) })).json();
  const b2 = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  const c2 = await b2.newContext({ ignoreHTTPSErrors: true });
  await c2.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", { get: function hardwareConcurrency() { return 16; }, configurable: true });
    const t = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function toDataURL(...a) {
      const x = this.getContext("2d");
      if (x) { x.fillStyle = `rgb(${(Math.random() * 256) | 0},${(Math.random() * 256) | 0},0)`; x.fillRect(0, 0, 1, 1); }
      return t.apply(this, a);
    };
  });
  const p2 = await c2.newPage();
  await p2.goto(`${base}/r/${link2.id}`);
  await p2.waitForTimeout(2500);
  await p2.click("#continue");
  await p2.waitForURL("**/api/whoami?destination=2", { timeout: 10000 });
  await b2.close();
  await new Promise((r) => setTimeout(r, 300));
  const [s2] = store.list(1);
  const f2 = (s2.verdict?.flags || []).map((f) => f.id);
  check("spoofed getters caught by CreepJS lie detection (C1)", f2.includes("C1-prototype-lies"), s2.client?.raw?.creep?.lies?.apis?.join(","));
  check("spoofed hardwareConcurrency differs in the service worker (C12)", f2.includes("C12-worker-scope-vs-page"));
  check("canvas noise caught by the page check (J6)", f2.includes("J6-canvas-noise"));
  check("spoofed visit scored as anti-detect", s2.verdict.antiDetect === true, `antiDetectScore=${s2.verdict.antiDetectScore}`);
  // Informational: whether either device ID survived the change of identity. CreepJS
  // drops components it caught lying from its stable ID, but a different set of
  // lies changes which components remain, so this is not guaranteed.
  console.log(`device IDs across identities: creep ${s2.verdict.ids?.creep === v.verdict.ids?.creep ? "same" : "changed"}, ` +
    `fpjs ${s2.verdict.ids?.fpjs === v.verdict.ids?.fpjs ? "same" : "changed"}`);
  console.log("spoof flags:", f2.join(", "));

  const st = await (await api("/api/status")).json();
  check("status lists databases and attribution", !geo || st.attribution.length > 0, JSON.stringify(st.attribution));
  console.log("\nflags:", flagIds.join(", "));
  console.log("creep headless:", JSON.stringify(cr?.headless), "resistance:", JSON.stringify(cr?.resistance), "bot:", JSON.stringify(cr?.bot));
  console.log("antiDetectScore:", v.verdict.antiDetectScore, " t4ClientMs:", v.client?.forward?.t4ClientMs);
} catch (e) {
  check("run completed", false, e.stack);
} finally {
  server.close();
  geo?.close();
  spawnSync(NGINX, ["-c", `${dir}/nginx.conf`, "-p", dir, "-s", "stop"]);
}
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
