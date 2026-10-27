import { haversineKm, zoneOffsetMinutes } from "./geo.js";
import { loadModel, predict, modelLoaded } from "./model.js";

loadModel(); // no-op unless MODEL_FILE is set

// Combines server, page and timing evidence into the plan's three verdicts.
// Weights and thresholds are placeholders: replace them with values fitted on
// labeled cohort runs (test plan, "Scoring, metrics and exit criteria").

export const THRESHOLDS = {
  suspectedAgent: 5,
  antiDetect: 5,
  rttGapMs: Number(process.env.RTT_GAP_MS || 50), // set from C1/C2 distributions
  tzToleranceMin: 60,          // J12 with a real IANA zone (GeoLite2 City)
  tzToleranceLonMin: 150,      // J12 when only longitude is known (DB-IP Lite)
  geoSlackKmUnknown: 300,      // H5 slack when the database gives no accuracy radius
  fiberKmPerMsRoundTrip: 100,  // light in fiber ~200 km/ms one way
};

export function uaOS(ua = "") {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "Chrome OS";
  if (/Linux/.test(ua)) return "Linux";
  return "unknown";
}

const CH_OS = { '"Windows"': "Windows", '"macOS"': "macOS", '"Linux"': "Linux", '"Android"': "Android",
                '"Chrome OS"': "Chrome OS", '"Chromium OS"': "Chrome OS", '"iOS"': "iOS" };

export function serverFlags(s) {
  const f = [];
  const os = uaOS(s.userAgent);
  const ch = CH_OS[s.secChUaPlatform];
  if (ch && os !== "unknown" && ch !== os) f.push({ id: "X1-ua-vs-client-hints", side: "both", w: 4, detail: `${os} vs ${ch}` });

  if (Number.isFinite(s.synTtl)) {
    const initial = s.synTtl <= 64 ? 64 : s.synTtl <= 128 ? 128 : 255;
    const expected = os === "Windows" ? 128 : ["macOS", "iOS", "Linux", "Android", "Chrome OS"].includes(os) ? 64 : null;
    if (expected && initial !== expected) f.push({ id: "X3-ttl-vs-ua-os", side: "both", w: 3, detail: `TTL ${s.synTtl} (initial ${initial}) vs ${os}` });
  }
  if (/HeadlessChrome/.test(s.userAgent || "")) f.push({ id: "J3-headless-ua", side: "agent", w: 5 });
  return f;
}

// TCP RTT of the WebSocket's own connection when nginx reported it, else the page request's.
const tcpRttUsOf = (server, rtt) => (Number.isFinite(rtt?.tcpRttUsWs) ? rtt.tcpRttUsWs : server.tcpRttUs);

export function timingFlags(server, rtt) {
  const f = [];
  const samples = rtt?.samplesMs || [];
  const tcpUs = tcpRttUsOf(server, rtt);
  if (samples.length && Number.isFinite(tcpUs)) {
    const gap = Math.min(...samples) - tcpUs / 1000;
    if (gap > THRESHOLDS.rttGapMs) f.push({ id: "H4-rtt-gap", side: "both", w: 3, detail: `${gap.toFixed(1)} ms` });
  }
  return f;
}

// J11: WebRTC public (srflx) address of the same IP family differs from the request IP.
export function webrtcFlags(server, client) {
  const ips = client?.raw?.webrtcSrflx;
  if (!Array.isArray(ips) || !ips.length || !server.ip) return [];
  const fam = (ip) => (ip.includes(":") ? 6 : 4);
  const same = ips.filter((ip) => fam(ip) === fam(server.ip));
  return same.length && !same.includes(server.ip)
    ? [{ id: "J11-webrtc-ip-mismatch", side: "antidetect", w: 3, detail: `${same.join(",")} vs ${server.ip}` }] : [];
}

// C12 (server side): the service/shared worker's User-Agent vs the one on the HTTP
// request. A page-level spoof that forgets the worker shows up here even when
// the page and the header agree.
export function probeFlags(server, client) {
  const w = client?.raw?.creep?.worker;
  if (!w?.userAgent || !server.userAgent || w.type === "dedicated") return [];
  // probes.js clips long values to 300 characters
  const http = server.userAgent.slice(0, 300);
  return w.userAgent !== http ? [{ id: "C12-worker-ua-vs-http-ua", side: "antidetect", w: 4, detail: `${w.type} worker UA differs from the request's` }] : [];
}

// N2: declared bot tokens checked against operator IP lists.
export function declaredFlags(server) {
  const d = server.declaredBot;
  if (!d) return [];
  if (d.status === "verified") return [{ id: "N2-declared-bot-verified", side: "agent", w: 5, detail: `${d.token} (${d.operator})` }];
  if (d.status === "spoofed") return [{ id: "N2-bot-token-wrong-ip", side: "both", w: 3, detail: `${d.token} from an IP not on ${d.operator}'s list` }];
  return [{ id: "N2-declared-bot-claimed", side: "agent", w: 3, detail: d.token }];
}

// Language regions from Accept-Language, e.g. "en-US,en;q=0.9,fr-CA" -> ["US","CA"].
export function languageRegions(header = "") {
  return [...new Set(header.split(",").map((t) => t.split(";")[0].trim())
    .map((t) => /^[a-z]{2,3}-([A-Z]{2})$/i.exec(t)?.[1]?.toUpperCase()).filter(Boolean))];
}

// N3, X4, J12, H5: everything that needs to know where the IP is.
export function geoFlags(server, client, at = Date.now()) {
  const f = [];
  const g = server.geo;
  if (!g || g.private) return f;

  if (g.hosting) f.push({ id: "N3-datacenter-asn", side: "both", w: 2, detail: `AS${g.asn} ${g.asOrg || ""} (${g.hostingReason})` });

  const regions = languageRegions(server.acceptLanguage);
  if (g.country && regions.length && !regions.includes(g.country)) {
    f.push({ id: "X4-language-vs-ip-country", side: "both", w: 1, detail: `${regions.join(",")} vs ${g.country}` });
  }

  const tz = client?.raw?.tzOffset;
  if (Number.isFinite(tz)) {
    let expected = null, tol = null, how = null;
    if (g.timeZone) { expected = zoneOffsetMinutes(g.timeZone, new Date(at)); tol = THRESHOLDS.tzToleranceMin; how = g.timeZone; }
    else if (Number.isFinite(g.lon)) { expected = Math.round(-g.lon / 15) * 60; tol = THRESHOLDS.tzToleranceLonMin; how = `longitude ${g.lon}`; }
    if (expected !== null && Math.abs(tz - expected) > tol) {
      f.push({ id: "J12-timezone-vs-ip", side: "both", w: 2, detail: `page offset ${tz} min vs ${expected} min (${how})` });
    }
  }

  const here = server.serverLocation;
  if (here && Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(server.tcpRttUs)) {
    const km = haversineKm(here.lat, here.lon, g.lat, g.lon);
    const slack = g.accuracyKm ?? THRESHOLDS.geoSlackKmUnknown;
    const floorMs = Math.max(0, km - slack) / THRESHOLDS.fiberKmPerMsRoundTrip;
    const rttMs = server.tcpRttUs / 1000;
    if (floorMs >= 5 && rttMs < 0.9 * floorMs) {
      f.push({ id: "H5-faster-than-light", side: "both", w: 3, detail: `RTT ${rttMs.toFixed(1)} ms < floor ${floorMs.toFixed(1)} ms for ${Math.round(km)} km` });
    }
  }
  return f;
}

export function computeVerdict(visit) {
  const server = visit.server || {};
  const client = visit.client || {};
  const flags = [...serverFlags(server), ...declaredFlags(server), ...geoFlags(server, client, visit.t0 || Date.now()),
    ...timingFlags(server, visit.rtt), ...webrtcFlags(server, client), ...probeFlags(server, client), ...(client.flags || [])];
  if (!client.flags) flags.push({ id: "N8-no-javascript", side: "agent", w: 2 });

  const score = (side) => flags.filter((x) => x.side === side || x.side === "both").reduce((a, x) => a + x.w, 0);
  const agentScore = score("agent");
  const antiDetectScore = score("antidetect");
  const sig = server.signature || {};
  const rttMin = visit.rtt?.samplesMs?.length ? Math.min(...visit.rtt.samplesMs) : null;
  const tcpUs = tcpRttUsOf(server, visit.rtt);
  const gapMs = rttMin != null && Number.isFinite(tcpUs) ? +(rttMin - tcpUs / 1000).toFixed(2) : null;

  // System-1 model percentages (only when MODEL_FILE is set). A verified
  // Web Bot Auth signature always wins the tag.
  let model = null;
  if (modelLoaded()) {
    model = predict({ flags: flags.map((f) => f.id), server, client: visit.client || null, hop: { gapMs } });
    if (model && sig.type === "verified-agent") model.tag = `agent (verified: ${sig.agent})`;
  }

  return {
    verifiedAgent: sig.type === "verified-agent" ? sig.agent : null,
    declaredBot: server.declaredBot || null,
    suspectedAgent: agentScore >= THRESHOLDS.suspectedAgent,
    antiDetect: antiDetectScore >= THRESHOLDS.antiDetect,
    agentScore, antiDetectScore, flags,
    hop: {
      tcpRttMs: Number.isFinite(tcpUs) ? tcpUs / 1000 : null,
      pageRttMinMs: rttMin,
      gapMs,
      synTtl: server.synTtl ?? null, synHops: server.synHops ?? null,
      geoFloorMs: (() => {
        const g = server.geo, h = server.serverLocation;
        if (!g || !h || !Number.isFinite(g.lat)) return null;
        const km = haversineKm(h.lat, h.lon, g.lat, g.lon) - (g.accuracyKm ?? THRESHOLDS.geoSlackKmUnknown);
        return +(Math.max(0, km) / THRESHOLDS.fiberKmPerMsRoundTrip).toFixed(2);
      })(),
    },
    model,
    geo: server.geo ? { country: server.geo.country, city: server.geo.city, asn: server.geo.asn, asOrg: server.geo.asOrg,
      hosting: server.geo.hosting, citySource: server.geo.citySource, asnSource: server.geo.asnSource } : null,
    ids: { creep: client.raw?.creep?.fpId ?? null, creepFuzzy: client.raw?.creep?.fuzzy ?? null,
      fpjs: client.raw?.fpjs?.visitorId ?? null },
  };
}
