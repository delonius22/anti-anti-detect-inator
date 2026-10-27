// The Anti-Anti-Detect-inator, server half.
//
// Measurement app: allowlisted short links -> stop page -> forward.
// Runs on 127.0.0.1 behind the patched nginx, which adds JA4/JA4H/JA4T,
// SYN TTL and TCP RTT as request headers (nginx/measure.conf).

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import { identifyAgent } from "./identify-agent.js";
import { toFetchRequest } from "./express-adapter.js";
import { openStore } from "./store.js";
import { computeVerdict } from "./scoring.js";
import { openGeo } from "./geo.js";
import { loadDeclaredBots } from "./declared-bots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// FingerprintJS v5 (MIT, no network calls in the open-source build), served from node_modules.
const FPJS_FILE = path.join(path.dirname(createRequire(import.meta.url).resolve("@fingerprintjs/fingerprintjs")), "fp.umd.min.js");
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const id = (bytes) => crypto.randomBytes(bytes).toString("base64url");
const num = (v) => (v === undefined || v === "" ? undefined : Number(v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createCaptureApp(opts = {}) {
  const cfg = {
    adminToken: opts.adminToken ?? process.env.ADMIN_TOKEN,
    allowedHosts: new Set((opts.allowedHosts ?? process.env.ALLOWED_HOSTS ?? "youtube.com,www.youtube.com,m.youtube.com,youtu.be")
      .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
    publicOrigin: opts.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? "",
    stunUrl: opts.stunUrl ?? process.env.STUN_URL ?? "stun:stun.l.google.com:19302",
    store: opts.store ?? openStore(opts.dbPath),
    geo: opts.geo ?? null,                                   // from openGeo(); null = no enrichment
    matchDeclaredBot: opts.matchDeclaredBot ?? loadDeclaredBots(opts.botIpsFile),
    serverLocation: opts.serverLocation ?? null,             // { lat, lon } for H5
  };
  if (!cfg.adminToken) throw new Error("Set ADMIN_TOKEN");
  const store = cfg.store;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // X-Forwarded-* only from local nginx

  const fromNginx = (req) => LOOPBACK.has(req.socket.remoteAddress);
  const admin = (req, res, next) => {
    const tok = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(tok), b = Buffer.from(cfg.adminToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.sendStatus(401);
  };

  async function serverFields(req) {
    const h = (n) => req.get(n);
    const trusted = fromNginx(req);
    const t = (n) => (trusted ? h(n) : undefined); // never accept fingerprint headers from the internet
    const ip = t("x-real-ip") || req.socket.remoteAddress;
    let signature;
    try { signature = await identifyAgent(toFetchRequest(req)); }
    catch (e) { signature = { type: "none", reason: "verifier-error: " + e.message }; }
    return {
      viaNginx: trusted,
      ip,
      remotePort: num(t("x-remote-port")),
      ja4: t("x-ja4"), ja4String: t("x-ja4-string"), ja4h: t("x-ja4h"), ja4hString: t("x-ja4h-string"),
      ja4t: t("x-ja4t"), synTtl: num(t("x-syn-ttl")), synHops: num(t("x-syn-hops")),
      tcpRttUs: num(t("x-tcp-rtt")), tcpRttVarUs: num(t("x-tcp-rttvar")), httpVersion: t("x-http-version"),
      userAgent: h("user-agent"), secChUa: h("sec-ch-ua"), secChUaPlatform: h("sec-ch-ua-platform"),
      secChUaMobile: h("sec-ch-ua-mobile"), acceptLanguage: h("accept-language"), accept: h("accept"),
      acceptEncoding: h("accept-encoding"), secFetchSite: h("sec-fetch-site"), secFetchMode: h("sec-fetch-mode"),
      secFetchDest: h("sec-fetch-dest"), secFetchUser: h("sec-fetch-user"),
      signature,
      geo: cfg.geo ? cfg.geo.lookup(ip) : null,
      declaredBot: cfg.matchDeclaredBot(h("user-agent") || "", ip),
      serverLocation: cfg.serverLocation,
    };
  }

  function rescore(visitId) {
    const v = store.getVisit(visitId);
    if (v) store.setVerdict(visitId, computeVerdict(v));
  }

  // --- admin: create links, read visits, check what the server sees -------
  app.post("/api/links", admin, express.json({ limit: "4kb" }), (req, res) => {
    const { url, cohort, tool, note, oneTime } = req.body || {};
    let u;
    try { u = new URL(url); } catch { return res.status(400).json({ error: "invalid url" }); }
    if (u.protocol !== "https:" || !cfg.allowedHosts.has(u.hostname.toLowerCase())) {
      return res.status(400).json({ error: `destination not allowed: ${u.hostname}` });
    }
    const linkId = id(6);
    store.addLink({ id: linkId, url: u.href, cohort, tool, note, oneTime });
    res.status(201).json({ id: linkId, short: `${cfg.publicOrigin}/r/${linkId}`, url: u.href });
  });
  const attribution = () => (cfg.geo ? cfg.geo.attribution() : []);
  app.get("/api/visits", admin, (req, res) => {
    const a = attribution();
    if (a.length) res.set("X-Data-Attribution", a.join(" | "));
    res.json(store.list(Math.min(Number(req.query.limit) || 100, 1000)));
  });
  app.get("/api/status", admin, (req, res) => res.json({
    geo: cfg.geo ? cfg.geo.status() : null, attribution: attribution(), serverLocation: cfg.serverLocation,
  }));
  app.get("/api/whoami", async (req, res) => { res.set("Cache-Control", "no-store"); res.json(await serverFields(req)); });

  // --- T0/T1: short link hit, stop page sent ------------------------------
  app.get("/r/:id", async (req, res) => {
    const t0 = Date.now();
    const link = store.getLink(req.params.id);
    if (!link) return res.sendStatus(404);
    if (link.one_time && link.used) return res.status(410).send("This link has already been used.");
    store.useLink(link.id);
    const visitId = id(12);
    const server = await serverFields(req);
    store.addVisit({ id: visitId, linkId: link.id, t0, ip: server.ip, server });
    rescore(visitId);
    res.on("finish", () => store.setT1(visitId, Date.now()));
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
    const host = new URL(link.url).hostname;
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30;url=/go/${visitId}?auto=1">
<title>Continue to ${esc(host)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#222}
main{max-width:28rem;padding:2rem;text-align:center}a.btn{display:inline-block;margin-top:1rem;padding:.75rem 1.5rem;border-radius:8px;background:#1a56db;color:#fff;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body data-visit="${visitId}" data-stun="${esc(cfg.stunUrl)}">
<main><p>You are leaving this site for <strong>${esc(host)}</strong>.</p>
<a class="btn" id="continue" href="/go/${visitId}">Continue to ${esc(host)}</a>
<noscript><p><a href="/go/${visitId}?nojs=1">Continue</a></p></noscript></main>
<script src="/probes.js" defer></script><script src="/s/f.js" defer></script>
<script src="/s/stop.js" defer></script></body></html>`);
  });

  // --- T3: page beacons (checks, behaviour, timing) -----------------------
  app.post("/api/beacon/:visitId", express.json({ type: "*/*", limit: "128kb" }), (req, res) => {
    const ok = store.mergeClient(req.params.visitId, req.body || {}, Date.now());
    if (ok) rescore(req.params.visitId);
    res.sendStatus(ok ? 204 : 404);
  });

  // --- T5: forward ---------------------------------------------------------
  app.get("/go/:visitId", (req, res) => {
    const v = store.getVisit(req.params.visitId);
    if (!v) return res.sendStatus(404);
    store.setT5(v.id, Date.now());
    const extra = { forward: { auto: "auto" in req.query, nojs: "nojs" in req.query, t4ClientMs: num(req.query.t4) } };
    store.mergeClient(v.id, extra, null);
    rescore(v.id);
    const link = store.getLink(v.link_id);
    res.set("Cache-Control", "no-store").redirect(302, link.url);
  });

  app.get("/s/stop.js", (req, res) => res.set("Cache-Control", "no-store").sendFile(path.join(here, "../client/stop.js")));
  // C-series probes: CreepJS collectors (vendor/creepjs, MIT). The same file is
  // also registered as a service/shared/dedicated worker, so it lives at the site
  // root (a service worker's scope must cover /r/). It has no fetch handler and
  // unregisters itself after one message, so it never intercepts page loads.
  app.get("/probes.js", (req, res) => res.set("Cache-Control", "no-store").type("text/javascript")
    .sendFile(path.join(here, "../client/probes.js")));
  // F-series: FingerprintJS v5 device ID.
  app.get("/s/f.js", (req, res) => res.set("Cache-Control", "public, max-age=3600").type("text/javascript").sendFile(FPJS_FILE));

  // --- H3: the Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-inator ------
  // In-page RTT over WebSocket, measured on the server's clock (ping10inator).
  function attachWebSocket(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      const u = new URL(req.url, "http://x");
      const visit = u.pathname === "/ws/rtt" && store.getVisit(u.searchParams.get("v") || "");
      if (!visit) return socket.destroy();
      const trusted = LOOPBACK.has(req.socket.remoteAddress);
      const tcpRttUs = trusted ? num(req.headers["x-tcp-rtt"]) : undefined;
      wss.handleUpgrade(req, socket, head, (ws) => runPings(ws, visit.id, tcpRttUs));
    });
  }
  function runPings(ws, visitId, tcpRttUs, rounds = 10) {
    const samplesMs = [];
    let i = 0, sentAt = 0;
    const next = () => {
      if (i >= rounds) {
        store.setRtt(visitId, { samplesMs, tcpRttUsWs: tcpRttUs ?? null });
        rescore(visitId);
        return ws.close(1000);
      }
      sentAt = performance.now();
      ws.send(String(i));
    };
    ws.on("message", (m) => {
      if (String(m) !== String(i)) return;
      samplesMs.push(+(performance.now() - sentAt).toFixed(3));
      i++;
      setTimeout(next, 50);
    });
    const kill = setTimeout(() => ws.terminate(), 15000);
    ws.on("close", () => clearTimeout(kill));
    next();
  }

  return { app, store, attachWebSocket };
}

// Server's own location for H5: SERVER_LAT/SERVER_LON, else look up SERVER_PUBLIC_IP.
export function resolveServerLocation(geo, env = process.env) {
  if (env.SERVER_LAT && env.SERVER_LON) return { lat: Number(env.SERVER_LAT), lon: Number(env.SERVER_LON), from: "env" };
  if (geo && env.SERVER_PUBLIC_IP) {
    const g = geo.lookup(env.SERVER_PUBLIC_IP);
    if (Number.isFinite(g.lat)) return { lat: g.lat, lon: g.lon, from: `lookup ${env.SERVER_PUBLIC_IP}` };
  }
  return null;
}

// Starts the app the way production runs it (also used by scripts/dev.js).
export async function startServer({ port = Number(process.env.PORT || 3000), host = "127.0.0.1" } = {}) {
  const geo = await openGeo();
  const serverLocation = resolveServerLocation(geo);
  console.log("geo databases:", JSON.stringify(geo.status()), "server location:", JSON.stringify(serverLocation));
  let matcher = loadDeclaredBots();                     // re-read hourly after scripts/update-bot-ips.js
  setInterval(() => { matcher = loadDeclaredBots(); }, 3600_000).unref();
  const { app, attachWebSocket } = createCaptureApp({ geo, serverLocation, matchDeclaredBot: (ua, ip) => matcher(ua, ip) });
  const server = app.listen(port, host, () => console.log(`capture app on ${host}:${port}`));
  attachWebSocket(server);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
