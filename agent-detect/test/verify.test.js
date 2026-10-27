// Simulates ChatGPT-style signed requests with the RFC 9421 test key served
// from a fake chatgpt.com key directory, then checks pass/fail cases.
import { sign, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import assert from "node:assert/strict";
import express from "express";
import { identifyAgent, _setFetchForTests } from "../server/identify-agent.js";
import { isPublicAddress } from "../server/key-directory.js";
import { toFetchRequest } from "../server/express-adapter.js";

const PRIV = { kty: "OKP", crv: "Ed25519", alg: "EdDSA", d: "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU", x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" };
const PUB = { kty: "OKP", crv: "Ed25519", x: PRIV.x };

// Key locations the fake network serves; everything else is a 404.
const PUBLISHED = {
  "https://chatgpt.com/.well-known/http-message-signatures-directory": { keys: [PUB] },
  "https://bot.example/.well-known/http-message-signatures-directory": { keys: [PUB] },
  "https://keys.example/jwks.json": { keys: [PUB] },
  "https://agent.example/card.json": { client_id: "https://agent.example/card.json", client_name: "Example Agent", jwks: { keys: [PUB] } },
};
const fetched = [];
_setFetchForTests(async (url) => {
  fetched.push(url);
  return url in PUBLISHED ? new Response(JSON.stringify(PUBLISHED[url])) : new Response("not found", { status: 404 });
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
  assert.equal(r.type, "verified-agent", r.reason); assert.equal(r.agent, "chatgpt"); assert.equal(r.known, true);
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

async function verifyAs(signatureAgent, url = "https://shop.example/") {
  return identifyAgent(new Request(url, { headers: await signed(url, signatureAgent) }));
}

await t("unknown signer, key directory -> verified, named by hostname, not known", async () => {
  const r = await verifyAs('sig1="https://bot.example"');
  assert.equal(r.type, "verified-agent", r.reason); assert.equal(r.agent, "bot.example"); assert.equal(r.known, false);
});

await t("unknown signer, type=jwks_uri -> verified", async () => {
  const r = await verifyAs('sig1="https://keys.example/jwks.json";type=jwks_uri');
  assert.equal(r.type, "verified-agent", r.reason); assert.equal(r.agent, "keys.example");
});

await t("unknown signer, type=cimd (agent card) -> verified, card name kept apart from agent", async () => {
  const r = await verifyAs('sig1="https://agent.example/card.json";type=cimd');
  assert.equal(r.type, "verified-agent", r.reason);
  assert.equal(r.agent, "agent.example"); assert.equal(r.cardName, "Example Agent");
});

await t("signer that publishes no keys -> rejected", async () => {
  const r = await verifyAs('sig1="https://nokeys.example"');
  assert.equal(r.type, "claimed-agent"); assert.match(r.reason, /404/);
});

for (const agent of ["https://127.0.0.1", "https://localhost", "https://[::1]", "https://169.254.169.254",
                     "http://bot.example", "https://bot.example:8443"]) {
  await t(`signer at ${agent} -> rejected, never fetched`, async () => {
    const before = fetched.length;
    const r = await verifyAs(`sig1="${agent}"`);
    assert.equal(r.type, "claimed-agent"); assert.equal(fetched.length, before);
  });
}

await t("only public addresses count as public", async () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
                    "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

await t("forged headers copied from a blog post -> rejected", async () => {
  const r = await identifyAgent(new Request("https://shop.example/", { headers: {
    "Signature-Agent": '"https://chatgpt.com"',
    "Signature-Input": 'sig1=("@authority" "@method" "@path" "signature-agent");created=1754340838;keyid="otMqcjr17mGyruktGvJU8oojQTSMHlVm7uO-lrcqbdg";expires=1754344438;tag="web-bot-auth";alg="ed25519"',
    Signature: "sig1=:AAAA:" } }));
  assert.equal(r.type, "claimed-agent");
});

// Which URL the verifier sees for a request carrying X-Forwarded-Host, under a given "trust proxy".
async function urlSeenWith(trustProxy, forwardedHost) {
  const app = express().set("trust proxy", trustProxy);
  app.get("/p/1", (req, res) => res.send(toFetchRequest(req).url));
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${server.address().port}/p/1`, { headers: { "X-Forwarded-Host": forwardedHost } });
    return new URL(await r.text());
  } finally { server.close(); }
}

await t("X-Forwarded-Host from an untrusted client -> ignored", async () => {
  assert.notEqual((await urlSeenWith(false, "shop.example")).host, "shop.example");
});

await t("X-Forwarded-Host from a trusted proxy -> used", async () => {
  assert.equal((await urlSeenWith("loopback", "shop.example")).host, "shop.example");
});

// Last: it spends the per-minute lookup budget.
await t("flood of new signers -> lookups capped per minute", async () => {
  const reasons = [];
  for (let i = 0; i < 40; i++) reasons.push((await verifyAs(`sig1="https://flood${i}.example"`)).reason);
  assert.ok(reasons.some((r) => /too many key lookups/.test(r)), "budget never hit");
  assert.ok(fetched.filter((u) => u.includes("flood")).length <= 30);
});

for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
