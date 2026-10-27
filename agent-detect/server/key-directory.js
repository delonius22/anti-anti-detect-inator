// Finds a Web Bot Auth signer's public keys from the Signature-Agent entry it signed.
//
// Any agent can be verified, so the URL fetched here is chosen by whoever sent the request.
// Every lookup is treated as hostile: https on port 443 only, public addresses only
// (checked when the socket connects, so DNS rebinding can't swap in an internal address),
// no redirects, small bodies, a short timeout, and a cap on outbound lookups per minute.
//
// Discovery types (draft-meunier-web-bot-auth-architecture):
//   directory  origin's /.well-known/http-message-signatures-directory (or the URI itself if it has a path)
//   jwks_uri   the URI is a JWK Set
//   cimd       the URI is a Signature Agent Card holding `jwks` or `jwks_uri`

import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { HTTP_MESSAGE_SIGNATURES_DIRECTORY, parseSignatureAgentCard } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

const KEY_TTL_MS = 60 * 60 * 1000; // re-read a signer's keys hourly
const FAILURE_TTL_MS = 5 * 60 * 1000; // a signer whose lookup failed is not retried for 5 minutes
const MISS_REFETCH_MIN_MS = 60 * 1000; // on unknown keyid, refetch at most once a minute
const MAX_CACHED_SIGNERS = 1000;
const MAX_LOOKUPS_PER_MINUTE = 30; // outbound fetches, across all signers
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

// Special-purpose ranges (RFC 6890 and IANA registries). Anything here is never fetched.
const NOT_PUBLIC = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) NOT_PUBLIC.addSubnet(addr, prefix, "ipv4");
// No ::ffff:0:0/96 rule: BlockList already applies the IPv4 rules to IPv4-mapped IPv6
// addresses, and that rule would also match every plain IPv4 address.
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) NOT_PUBLIC.addSubnet(addr, prefix, "ipv6");

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  return family !== 0 && !NOT_PUBLIC.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// Cheap checks before any network activity; the DNS answer is checked again in publicLookup.
function assertFetchable(url) {
  if (url.protocol !== "https:") throw new Error(`key URL must use https: ${url.href}`);
  if (url.port !== "") throw new Error(`key URL must use the default port: ${url.href}`);
  if (url.username || url.password) throw new Error("key URL must not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) ? !isPublicAddress(host) : host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`key URL is not on a public address: ${url.href}`);
  }
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => !isPublicAddress(a.address));
    if (blocked) return callback(new Error(`${hostname} resolves to non-public address ${blocked.address}`));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      lookup: publicLookup,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} returned ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error(`${url} is larger than ${MAX_BODY_BYTES} bytes`));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error(`${url} is not JSON`)); }
      });
    });
    req.on("error", reject);
  });
}

let fetchJson = getJson;
// Tests swap the network for a fetch-style function: (url) => Promise<Response>.
export function _setFetchForTests(fn) {
  fetchJson = async (url) => {
    const res = await fn(url);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.json();
  };
  cache.clear();
  inFlight.clear();
  lookupTimes.length = 0;
}

const lookupTimes = [];
function fetchWithinBudget(url) {
  assertFetchable(url);
  const now = Date.now();
  while (lookupTimes.length && lookupTimes[0] < now - 60_000) lookupTimes.shift();
  if (lookupTimes.length >= MAX_LOOKUPS_PER_MINUTE) throw new Error("too many key lookups; try again later");
  lookupTimes.push(now);
  return fetchJson(url.href);
}

function directoryUrl(uri) {
  const url = new URL(uri);
  return url.pathname === "/" && !url.search ? new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, url.origin) : url;
}

// -> { keys: JsonWebKey[], cardName?: string }
async function fetchKeySet({ uri, type }) {
  if (type === "directory") return { keys: (await fetchWithinBudget(directoryUrl(uri))).keys };
  if (type === "jwks_uri") return { keys: (await fetchWithinBudget(new URL(uri))).keys };
  if (type === "cimd") {
    const card = parseSignatureAgentCard(await fetchWithinBudget(new URL(uri)), uri);
    const jwks = card.jwks ?? await fetchWithinBudget(new URL(card.jwks_uri));
    return { keys: jwks.keys, cardName: card.client_name };
  }
  throw new Error(`unsupported Signature-Agent type ${type}`);
}

async function buildVerifiers(keys) {
  if (!Array.isArray(keys)) throw new Error("key set has no keys array");
  const verifiers = new Map();
  for (const jwk of keys) {
    try {
      const v = await verifierFromJWK(jwk); // keyid = RFC 7638 JWK thumbprint
      verifiers.set(v.keyid, v);
    } catch { /* skip key types we can't use */ }
  }
  return verifiers;
}

// "type uri" -> { verifiers, cardName, checkedAt } | { failedAt, error }
const cache = new Map();
const inFlight = new Map(); // "type uri" -> Promise, so concurrent requests share one fetch

function remember(key, value) {
  cache.delete(key); // re-insert so Map order tracks recency
  cache.set(key, value);
  if (cache.size > MAX_CACHED_SIGNERS) cache.delete(cache.keys().next().value);
}

// A failed refresh keeps the last good keys, so nobody can knock out a working signer
// by forcing refetches (e.g. with made-up keyids) while the lookup budget is spent.
async function refresh(key, entry, previous) {
  try {
    const { keys, cardName } = await fetchKeySet(entry);
    const value = { verifiers: await buildVerifiers(keys), cardName, checkedAt: Date.now() };
    remember(key, value);
    return value;
  } catch (error) {
    if (!previous) { remember(key, { failedAt: Date.now(), error }); throw error; }
    const value = { ...previous, checkedAt: Date.now() };
    remember(key, value);
    return value;
  }
}

/**
 * Keys for a Signature-Agent entry that the signature covers. Refetches when the
 * keys are over an hour old, or (at most once a minute) when `keyid` is missing,
 * in case the signer rotated keys.
 * @param {{uri:string, type:"directory"|"jwks_uri"|"cimd"}} entry
 * @returns {Promise<{verifiers: Map<string, object>, cardName?: string}>}
 */
export async function loadSignerKeys(entry, keyid) {
  const key = `${entry.type} ${entry.uri}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const hit = cache.get(key);
  if (hit?.failedAt) {
    if (Date.now() - hit.failedAt < FAILURE_TTL_MS) throw hit.error;
  } else if (hit) {
    const stale = Date.now() - hit.checkedAt >= KEY_TTL_MS;
    const mayHaveRotated = !hit.verifiers.has(keyid) && Date.now() - hit.checkedAt >= MISS_REFETCH_MIN_MS;
    if (!stale && !mayHaveRotated) return hit;
  }
  const pending = refresh(key, entry, hit?.verifiers ? hit : undefined).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}
