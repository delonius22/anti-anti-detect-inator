// Loads the demo page in headless Chromium twice:
//   A) plain automation (unsigned)  -> expect "suspected-agent" from heuristics
//   B) every request signed like ChatGPT's cloud browser -> expect "verified-agent"
import { chromium } from "playwright";
import { sign, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { _setFetchForTests } from "../server/identify-agent.js";
import { createApp, openReports } from "../server/demo.js";

const PRIV = { kty: "OKP", crv: "Ed25519", alg: "EdDSA", d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
_setFetchForTests(async () => new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: PRIV.x }] })));

// The page shows nothing, so read what it reported from the server's store.
const reports = openReports(":memory:");
const nextReport = reports.db.prepare("SELECT id, client FROM reports WHERE id > ? ORDER BY id LIMIT 1");
let lastReportId = 0;
async function waitForReport(label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const row = nextReport.get(lastReportId);
    if (row) { lastReportId = row.id; return JSON.parse(row.client); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: no report stored within ${timeoutMs} ms`);
}
const server = createApp({ reports }).listen(0);
const base = `http://localhost:${server.address().port}`;
const signer = await signerFromJWK(PRIV);
const browser = await chromium.launch();

async function run(label, signRequests) {
  const ctx = await browser.newContext({
    // mimic the observed ChatGPT agent: macOS Chrome UA on a Linux box
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  if (signRequests) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      const agent = '"https://chatgpt.com"';
      const now = new Date();
      const f = await sign(new Request(req.url(), { method: req.method(), headers: { "Signature-Agent": agent } }),
        { signer, created: now, expires: new Date(+now + 60_000), nonce: generateNonce() });
      await route.continue({ headers: { ...req.headers(), "signature-agent": agent, signature: f.signature, "signature-input": f.signatureInput } });
    });
  }
  await page.goto(base + "/?ms=1500");
  await page.mouse.click(20, 20); await page.mouse.click(30, 30); // CDP clicks, no movement in between
  const v = await waitForReport(label);
  console.log(`\n== ${label} ==\nverdict=${v.verdict} agent=${v.agent ?? "-"} score=${v.score}\nserver=${JSON.stringify(v.server)}`);
  for (const s of v.signals) console.log("  signal:", s.id, s.detail ?? "");
  await ctx.close();
  return v;
}

const a = await run("A: unsigned headless automation", false);
const b = await run("B: ChatGPT-style signed cloud browser", true);
await browser.close(); server.close();
const ok = a.verdict === "suspected-agent" && b.verdict === "verified-agent" && b.agent === "chatgpt";
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL"); process.exit(ok ? 0 : 1);
