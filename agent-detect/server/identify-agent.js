// Server-side AI-agent identification.
//
// Verifies Web Bot Auth (RFC 9421 HTTP Message Signatures) on an incoming
// request. This is the ONLY reliable way to identify ChatGPT's cloud browser
// (used by ChatGPT agent / ChatGPT Work and, presumably, dots): it sends an
// ordinary Chrome User-Agent, so nothing in page JavaScript can name it.
//
// Works with any runtime that has the Fetch API `Request` (Node 18+, Cloudflare
// Workers, Next.js middleware, Deno, Bun). See express-adapter.js for Express.

import { verify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

// Signers you are willing to recognise. Only these origins are ever contacted
// for keys; an attacker-chosen Signature-Agent URL is never fetched.
// Add others (e.g. Browserbase, Anchor) once you confirm their directory URL.
export const TRUSTED_SIGNERS = {
  "https://chatgpt.com": { name: "chatgpt", operator: "openai" },
};

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
const KEY_TTL_MS = 60 * 60 * 1000; // re-read the key directory hourly
const MISS_REFETCH_MIN_MS = 60 * 1000; // on unknown keyid, refetch at most once a minute

const keyCache = new Map(); // origin -> { fetchedAt, verifiers: Map<keyid, verifier> }
const seenNonces = new Map(); // nonce -> expiresAtMs   (use Redis if you run >1 instance)

let fetchImpl = globalThis.fetch;
export function _setFetchForTests(fn) { fetchImpl = fn; }

async function loadVerifiers(origin, { force = false } = {}) {
  const cached = keyCache.get(origin);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && !force && age < KEY_TTL_MS) return cached.verifiers;
  if (cached && force && age < MISS_REFETCH_MIN_MS) return cached.verifiers;

  const res = await fetchImpl(origin + DIRECTORY_PATH, {
    headers: { accept: "application/http-message-signatures-directory+json, application/json" },
  });
  if (!res.ok) throw new Error(`key directory ${origin} returned ${res.status}`);
  const { keys = [] } = await res.json();

  const verifiers = new Map();
  for (const jwk of keys) {
    try {
      const v = await verifierFromJWK(jwk); // keyid = RFC 7638 JWK thumbprint
      verifiers.set(v.keyid, v);
    } catch { /* skip key types we can't use */ }
  }
  keyCache.set(origin, { fetchedAt: Date.now(), verifiers });
  return verifiers;
}

function rememberNonce(nonce, expires) {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false; // replay
  seenNonces.set(nonce, expires.getTime());
  return true;
}

/**
 * @param {Request} request  Must carry the PUBLIC URL the agent requested
 *                           (correct host + path), because the signature covers
 *                           @authority and usually @path. Behind a proxy, rebuild
 *                           it from X-Forwarded-Host / X-Forwarded-Proto.
 * @returns {Promise<{type:"verified-agent"|"claimed-agent"|"none", agent?:string,
 *                    operator?:string, reason:string}>}
 */
export async function identifyAgent(request) {
  const h = request.headers;
  if (!h.get("signature") || !h.get("signature-input")) {
    return { type: "none", reason: "no-signature" };
  }

  let signer;
  let resolverError;
  try {
    const result = await verify(request, {
      async resolver(candidate) {
        const origin = candidate.signatureAgent?.uri?.replace(/\/+$/, "");
        if (!origin || !TRUSTED_SIGNERS[origin]) throw (resolverError = new Error("untrusted signer: " + (origin || "none covered")));
        signer = origin;
        let verifiers = await loadVerifiers(origin);
        if (!verifiers.has(candidate.keyid)) {
          verifiers = await loadVerifiers(origin, { force: true }); // key rotation
        }
        const v = verifiers.get(candidate.keyid);
        if (!v) throw (resolverError = new Error("unknown keyid"));
        return v;
      },
      validate(sig) {
        if (sig.nonce && !rememberNonce(sig.nonce, sig.expires)) return false;
      },
      clockSkew: 60,
    });
    const meta = TRUSTED_SIGNERS[signer];
    return { type: "verified-agent", agent: meta.name, operator: meta.operator,
             reason: "web-bot-auth", keyid: result.keyid };
  } catch (err) {
    // Headers present but verification failed: spoofed, replayed, expired,
    // wrong host behind a proxy, or a signer you don't trust. Never treat as verified.
    const claimed = (h.get("signature-agent") || "").match(/https:\/\/[^"\s;,]+/)?.[0];
    return { type: "claimed-agent", agent: claimed, reason: String((resolverError || err)?.message || err) };
  }
}
