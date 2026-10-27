// Geo fallback, N2 declared bots, and the N3/X4/J12/H5 scoring rules.
//   GEO_TEST_DIR=<dir with MaxMind test mmdbs + dbip-city-lite.mmdb> node test/geo.test.js
// MaxMind test databases: github.com/maxmind/MaxMind-DB/tree/main/test-data
// DB-IP Lite city: npm package dbip-city-lite (gunzip dbip-city-lite.mmdb.gz)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openGeo, zoneOffsetMinutes, haversineKm } from "../server/geo.js";
import { classifyAsn } from "../server/hosting-asns.js";
import { extractCidrs, loadDeclaredBots } from "../server/declared-bots.js";
import { geoFlags, declaredFlags, languageRegions } from "../server/scoring.js";

const SRC = process.env.GEO_TEST_DIR;
if (!SRC) { console.error("Set GEO_TEST_DIR"); process.exit(2); }
const results = [];
async function t(name, fn) { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); } }
const ids = (f) => f.map((x) => x.id);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-"));
fs.copyFileSync(path.join(SRC, "dbip-city-lite.mmdb"), path.join(dir, "dbip-city-lite.mmdb"));

await t("DB-IP only: lookup works, no time zone or radius", async () => {
  const geo = await openGeo({ dir, checkEveryMs: 0 });
  const g = geo.lookup("8.8.8.8");
  assert.equal(g.citySource, "dbip"); assert.equal(g.country, "US");
  assert.equal(g.timeZone, null); assert.equal(g.accuracyKm, null);
  assert.deepEqual(geo.attribution(), ["IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0"]);
  geo.close();
});

fs.copyFileSync(path.join(SRC, "GeoLite2-City-Test.mmdb"), path.join(dir, "GeoLite2-City.mmdb"));
fs.copyFileSync(path.join(SRC, "GeoLite2-ASN-Test.mmdb"), path.join(dir, "GeoLite2-ASN.mmdb"));
const geo = await openGeo({ dir, checkEveryMs: 0 });

await t("MaxMind answers first when it has the IP", () => {
  const g = geo.lookup("81.2.69.142");
  assert.equal(g.citySource, "maxmind"); assert.equal(g.city, "London");
  assert.equal(g.timeZone, "Europe/London"); assert.equal(g.accuracyKm, 10);
});
await t("falls back to DB-IP when MaxMind has no record", () => {
  const g = geo.lookup("8.8.8.8");
  assert.equal(g.citySource, "dbip"); assert.equal(g.country, "US");
});
await t("ASN from MaxMind ASN database", () => {
  const g = geo.lookup("1.128.0.0");
  assert.equal(g.asn, 1221); assert.equal(g.asnSource, "maxmind"); assert.equal(g.hosting, false);
});
await t("private addresses are not looked up", () => {
  assert.equal(geo.lookup("127.0.0.1").private, true);
  assert.equal(geo.lookup("10.1.2.3").private, true);
  assert.equal(geo.lookup("::1").private, true);
});
await t("both sources credited when both are loaded", () => assert.equal(geo.attribution().length, 2));

await t("hosting ASN classification", () => {
  assert.equal(classifyAsn(16509, "AMAZON-02").hosting, true);
  assert.equal(classifyAsn(64500, "Example Hosting GmbH").hosting, true);
  assert.equal(classifyAsn(7922, "COMCAST-7922").hosting, false);
});

await t("time zone offsets in getTimezoneOffset convention", () => {
  assert.equal(zoneOffsetMinutes("America/Chicago", new Date("2026-07-01T12:00:00Z")), 300);
  assert.equal(zoneOffsetMinutes("America/Chicago", new Date("2026-01-15T12:00:00Z")), 360);
  assert.equal(zoneOffsetMinutes("Asia/Kolkata", new Date("2026-07-01T12:00:00Z")), -330);
});

const summer = new Date("2026-07-01T12:00:00Z").getTime();
const fra = { lat: 50.11, lon: 8.68 };
await t("N3 flags a hosting ASN", () => {
  const f = geoFlags({ geo: { asn: 16509, asOrg: "AMAZON-02", hosting: true, hostingReason: "known" } }, {});
  assert.ok(ids(f).includes("N3-datacenter-asn"));
});
await t("X4 language regions vs IP country", () => {
  assert.deepEqual(languageRegions("en-US,en;q=0.9,fr-CA;q=0.8"), ["US", "CA"]);
  assert.ok(ids(geoFlags({ geo: { country: "GB" }, acceptLanguage: "en-US,en" }, {})).includes("X4-language-vs-ip-country"));
  assert.ok(!ids(geoFlags({ geo: { country: "GB" }, acceptLanguage: "en-GB,en" }, {})).includes("X4-language-vs-ip-country"));
  assert.ok(!ids(geoFlags({ geo: { country: "GB" }, acceptLanguage: "en" }, {})).includes("X4-language-vs-ip-country"));
});
await t("J12 with a real zone (MaxMind)", () => {
  const server = { geo: { timeZone: "Europe/London" } };
  assert.ok(ids(geoFlags(server, { raw: { tzOffset: 300 } }, summer)).includes("J12-timezone-vs-ip"));
  assert.ok(!ids(geoFlags(server, { raw: { tzOffset: -60 } }, summer)).includes("J12-timezone-vs-ip"));
});
await t("J12 from longitude only (DB-IP)", () => {
  const server = { geo: { lon: -122.08, timeZone: null } };
  assert.ok(!ids(geoFlags(server, { raw: { tzOffset: 420 } }, summer)).includes("J12-timezone-vs-ip"));
  assert.ok(ids(geoFlags(server, { raw: { tzOffset: -60 } }, summer)).includes("J12-timezone-vs-ip"));
});
await t("H5 speed-of-light floor", () => {
  const g = { lat: 37.42, lon: -122.08, accuracyKm: null };
  const km = haversineKm(fra.lat, fra.lon, g.lat, g.lon);
  assert.ok(km > 9000 && km < 9300, `distance ${km}`);
  assert.ok(ids(geoFlags({ geo: g, serverLocation: fra, tcpRttUs: 2000 }, {})).includes("H5-faster-than-light"));
  assert.ok(!ids(geoFlags({ geo: g, serverLocation: fra, tcpRttUs: 150000 }, {})).includes("H5-faster-than-light"));
});

const botFile = path.join(dir, "bot-ips.json");
fs.writeFileSync(botFile, JSON.stringify({
  "ChatGPT-User": { cidrs: extractCidrs({ creationTime: "x", prefixes: [{ ipv4Prefix: "198.51.100.0/24" }, { ipv6Prefix: "2001:db8::/32" }] }) },
}));
const match = loadDeclaredBots(botFile);
const UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
await t("N2 verified when the IP is on the operator's list", () => {
  const d = match(UA, "198.51.100.7");
  assert.equal(d.status, "verified");
  assert.ok(ids(declaredFlags({ declaredBot: d })).includes("N2-declared-bot-verified"));
});
await t("N2 spoofed when the token comes from elsewhere", () => {
  const d = match(UA, "203.0.113.9");
  assert.equal(d.status, "spoofed");
  assert.ok(ids(declaredFlags({ declaredBot: d })).includes("N2-bot-token-wrong-ip"));
});
await t("N2 IPv6 range match", () => assert.equal(match(UA, "2001:db8::1").status, "verified"));
await t("N2 claimed when no list is wired in", () => assert.equal(match("Claude-User/1.0", "203.0.113.9").status, "claimed"));
await t("N2 ignores ordinary browsers", () => assert.equal(match("Mozilla/5.0 (Windows NT 10.0) Chrome/138.0", "203.0.113.9"), null));

geo.close();
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
