// IP enrichment: MaxMind GeoLite2 first, DB-IP Lite as fallback, per lookup.
// City and ASN are resolved independently, so a gap in one database is filled
// by the other. Both use the MaxMind DB (.mmdb) format.
//
// Expected files in GEOIP_DIR (deploy/update-geoip.sh puts them there):
//   GeoLite2-City.mmdb  GeoLite2-ASN.mmdb      (MaxMind, needs a free account)
//   dbip-city-lite.mmdb dbip-asn-lite.mmdb     (DB-IP Lite, CC BY 4.0)
// Missing files are skipped. DB-IP Lite has no time zone or accuracy radius.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import maxmind from "maxmind";
import { classifyAsn } from "./hosting-asns.js";

export const ATTRIBUTION = {
  maxmind: "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com",
  dbip: "IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0",
};

const FILES = {
  maxmind: { city: "GeoLite2-City.mmdb", asn: "GeoLite2-ASN.mmdb" },
  dbip: { city: "dbip-city-lite.mmdb", asn: "dbip-asn-lite.mmdb" },
};
const ORDER = ["maxmind", "dbip"];

const PRIVATE = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10]]) PRIVATE.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::1", 128], ["fc00::", 7], ["fe80::", 10]]) PRIVATE.addSubnet(a, p, "ipv6");

export function isPrivate(ip) {
  const v = net.isIP(ip);
  return v === 0 || PRIVATE.check(ip, v === 4 ? "ipv4" : "ipv6");
}

export async function openGeo({ dir = process.env.GEOIP_DIR || "/var/lib/capture-app/geoip", files = FILES, checkEveryMs = 3600_000 } = {}) {
  const readers = {}; // `${source}.${kind}` -> { reader, mtimeMs, built }

  async function load(source, kind) {
    const file = path.join(dir, files[source][kind]);
    let st;
    try { st = fs.statSync(file); } catch { delete readers[`${source}.${kind}`]; return; }
    const cur = readers[`${source}.${kind}`];
    if (cur && cur.mtimeMs === st.mtimeMs) return;
    try {
      const reader = await maxmind.open(file);
      const be = reader.metadata.buildEpoch; // the maxmind package returns a Date
      const built = be instanceof Date ? be : new Date(Number(be) * 1000);
      readers[`${source}.${kind}`] = { reader, mtimeMs: st.mtimeMs, file,
        built: Number.isNaN(built.getTime()) ? null : built.toISOString().slice(0, 10), type: reader.metadata.databaseType };
    } catch (e) {
      console.error(`geo: cannot open ${file}: ${e.message}`); // keep the previous reader if any
    }
  }
  async function reload() {
    for (const s of ORDER) for (const k of ["city", "asn"]) await load(s, k);
  }
  await reload();
  const timer = checkEveryMs ? setInterval(() => reload().catch(() => {}), checkEveryMs) : null;
  timer?.unref?.();

  function first(kind, ip, ok) {
    for (const s of ORDER) {
      const r = readers[`${s}.${kind}`];
      if (!r) continue;
      let rec = null;
      try { rec = r.reader.get(ip); } catch { rec = null; }
      if (rec && ok(rec)) return { source: s, rec };
    }
    return { source: null, rec: null };
  }

  function lookup(ip) {
    if (!ip || isPrivate(ip)) return { private: true };
    const c = first("city", ip, (r) => r.country || r.location);
    const a = first("asn", ip, (r) => r.autonomous_system_number);
    const loc = c.rec?.location || {};
    const asn = a.rec?.autonomous_system_number ?? null;
    const asOrg = a.rec?.autonomous_system_organization ?? null;
    const cls = asn ? classifyAsn(asn, asOrg || "") : { hosting: null, reason: null };
    return {
      country: c.rec?.country?.iso_code ?? null,
      region: c.rec?.subdivisions?.[0]?.names?.en ?? null,
      city: c.rec?.city?.names?.en ?? null,
      lat: loc.latitude ?? null, lon: loc.longitude ?? null,
      accuracyKm: loc.accuracy_radius ?? null,
      timeZone: loc.time_zone ?? null,
      citySource: c.source,
      asn, asOrg, asnSource: a.source,
      hosting: cls.hosting, hostingReason: cls.reason,
    };
  }

  function status() {
    return Object.fromEntries(Object.entries(readers).map(([k, v]) => [k, { file: v.file, built: v.built, type: v.type }]));
  }
  function attribution() {
    return ORDER.filter((s) => readers[`${s}.city`] || readers[`${s}.asn`]).map((s) => ATTRIBUTION[s]);
  }
  return { lookup, reload, status, attribution, close: () => timer && clearInterval(timer) };
}

// Great-circle distance in km.
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Current UTC offset of an IANA zone in Date#getTimezoneOffset() convention
// (minutes, positive west of UTC: Chicago in summer = 300).
export function zoneOffsetMinutes(timeZone, date = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(s);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === "+" ? -mins : mins;
}
