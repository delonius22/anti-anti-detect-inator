// Simulates ChatGPT-style signed requests with the RFC 9421 test key served
// from a fake chatgpt.com key directory, then checks pass/fail cases.
import { sign, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import assert from "node:assert/strict";
import { identifyAgent, _setFetchForTests } from "../server/identify-agent.js";

const PRIV = { kty: "OKP", crv: "Ed25519", alg: "EdDSA", d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const PUB = { kty: "OKP", crv: "Ed25519", x: PRIV.x };

const fetched = [];
_setFetchForTests(async (url) => {
  fetched.push(url);
  assert.equal(url, "https://chatgpt.com/.well-known/http-message-signatures-directory");
  return new Response(JSON.stringify({ keys: [PUB] }), { status: 200 });
});

async function signed(url, agentHeader, extra = {}) {
  const signer = await signerFromJWK(PRIV);
  const base = new Request(url, { headers: { "Signature-Agent": agentHeader } });
  const now = new Date();
  const f = await sign(base, { signer, created: now, expires: new Date(+now + 300_000), nonce: generateNonce(), ...extra });
  return { Signature: f.signature, "Signature-Input": f.signatureInput, "Signature-Agent": agentHeader };
}

const results = [];
async function t(name, fn) { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); } }

await t("unsigned request -> none", async () => {
  const r = await identifyAgent(new Request("https://shop.example/p/1"));
  assert.equal(r.type, "none");
});

let replayHeaders;
await t("valid current-format signature -> verified chatgpt", async () => {
  replayHeaders = await signed("https://shop.example/p/1", 'sig1="https://chatgpt.com"');
  const r = await identifyAgent(new Request("https://shop.example/p/1", { headers: replayHeaders }));
  assert.equal(r.type, "verified-agent", r.reason); assert.equal(r.agent, "chatgpt");
});

await t("legacy format exactly as ChatGPT sent it ('\"https://chatgpt.com\"') -> verified", async () => {
  const h = await signed("https://shop.example/cart", '"https://chatgpt.com"');
  const r = await identifyAgent(new Request("https://shop.example/cart", { headers: h }));
  assert.equal(r.type, "verified-agent", r.reason);
});

await t("replayed nonce -> rejected", async () => {
  const r = await identifyAgent(new Request("https://shop.example/p/1", { headers: replayHeaders }));
  assert.equal(r.type, "claimed-agent");
});

await t("signature for another host -> rejected", async () => {
  const h = await signed("https://other.example/p/1", 'sig1="https://chatgpt.com"');
  const r = await identifyAgent(new Request("https://shop.example/p/1", { headers: h }));
  assert.equal(r.type, "claimed-agent");
});

await t("untrusted signer origin -> rejected, never fetched", async () => {
  const h = await signed("https://shop.example/", 'sig1="https://evil.example"');
  const r = await identifyAgent(new Request("https://shop.example/", { headers: h }));
  assert.equal(r.type, "claimed-agent"); assert.match(r.reason, /untrusted/);
  assert.ok(!fetched.some((u) => u.includes("evil")));
});

await t("forged headers copied from a blog post -> rejected", async () => {
  const r = await identifyAgent(new Request("https://shop.example/", { headers: {
    "Signature-Agent": '"https://chatgpt.com"',
    "Signature-Input": 'sig1=("@authority" "@method" "@path" "signature-agent");created=1754340838;keyid="otMqcjr17mGyruktGvJU8oojQTSMHlVm7uO-lrcqbdg";expires=1754344438;tag="web-bot-auth";alg="ed25519"',
    Signature: "sig1=:AAAA:" } }));
  assert.equal(r.type, "claimed-agent");
});

for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
