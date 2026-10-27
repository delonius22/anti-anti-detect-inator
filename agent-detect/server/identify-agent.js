// Server-side AI-agent identification.
//
// Verifies Web Bot Auth (RFC 9421 HTTP Message Signatures) on an incoming
// request. A browser driven by a person never signs, so a valid signature from
// any signer means an automated agent. It is also the only way to name agents
// like ChatGPT's cloud browser (ChatGPT agent / ChatGPT Work and, presumably,
// dots), which send an ordinary Chrome User-Agent.
//
// Works with any runtime that has the Fetch API `Request` (Node 18+, Cloudflare
// Workers, Next.js middleware, Deno, Bun). See express-adapter.js for Express.

import { verify } from "web-bot-auth";
import { loadSignerKeys } from "./key-directory.js";

export { _setFetchForTests } from "./key-directory.js";

// Signers you recognise, by origin. Any other signer with a valid signature is still
// `verified-agent`, named by its hostname with `known: false`. Anyone can publish keys
// for a domain they own, so a signature proves which domain signed, not that it is
// trustworthy. Base trust decisions on `known` (or your own list of signers).
export const KNOWN_SIGNERS = {
  "https://chatgpt.com": { name: "chatgpt", operator: "openai" },
};

const seenNonces = new Map(); // nonce -> expiresAtMs   (use Redis if you run >1 instance)

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
 * @returns {Promise<{type:"verified-agent"|"claimed-agent"|"none", reason:string,
 *   agent?:string,     known signer's name, else the signer's hostname (claimed-agent: the URL it claimed)
 *   known?:boolean,    signer is in KNOWN_SIGNERS
 *   operator?:string, signer?:string, signerType?:string, cardName?:string, keyid?:string}>}
 */
export async function identifyAgent(request) {
  const h = request.headers;
  if (!h.get("signature") || !h.get("signature-input")) {
    return { type: "none", reason: "no-signature" };
  }

  let signer, cardName, resolverError;
  try {
    const result = await verify(request, {
      async resolver(candidate) {
        // Only present when the signature covers the Signature-Agent header, so it can't be swapped.
        // verify() replaces resolver errors with a generic one, so keep ours for `reason`.
        try {
          signer = candidate.signatureAgent;
          if (!signer) throw new Error("signature does not cover Signature-Agent");
          const keys = await loadSignerKeys(signer, candidate.keyid);
          cardName = keys.cardName;
          const v = keys.verifiers.get(candidate.keyid);
          if (!v) throw new Error("unknown keyid");
          return v;
        } catch (err) { throw (resolverError = err); }
      },
      validate(sig) {
        if (sig.nonce && !rememberNonce(sig.nonce, sig.expires)) return false;
      },
      clockSkew: 60,
    });
    const signerUrl = new URL(signer.uri);
    const known = KNOWN_SIGNERS[signerUrl.origin];
    return { type: "verified-agent", agent: known?.name ?? signerUrl.hostname, operator: known?.operator,
             known: Boolean(known), signer: signer.uri, signerType: signer.type,
             cardName, // self-described by the signer (cimd only); display only
             reason: "web-bot-auth", keyid: result.keyid };
  } catch (err) {
    // Headers present but verification failed: spoofed, replayed, expired, wrong
    // host behind a proxy, or keys we couldn't fetch. Never treat as verified.
    const claimed = (h.get("signature-agent") || "").match(/https?:\/\/[^"\s;,]+/)?.[0];
    return { type: "claimed-agent", agent: claimed, reason: String((resolverError || err)?.message || err) };
  }
}
