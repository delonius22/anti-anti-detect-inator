// Exports the visit store for Phase 6 analysis and prints the signal-grading
// table from the test plan (how often each flag fires in each cohort).
//   node scripts/export-visits.js [outDir]      (reads DB_PATH)
// Writes visits.csv (one row per visit, one 0/1 column per flag) and visits.jsonl.
import fs from "node:fs";
import path from "node:path";
import { openStore } from "../server/store.js";

const outDir = process.argv[2] || ".";
const store = openStore();
const visits = store.list(1_000_000);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "visits.jsonl"), visits.map((v) => JSON.stringify(v)).join("\n") + "\n");

const flagIds = [...new Set(visits.flatMap((v) => (v.verdict?.flags || []).map((f) => f.id)))].sort();
const cols = ["visit_id", "cohort", "tool", "t1_ms", "t3_ms", "t5_ms", "country", "asn", "as_org", "hosting",
  "ja4", "ja4h", "ja4t", "syn_ttl", "syn_hops", "tcp_rtt_ms", "page_rtt_min_ms", "rtt_gap_ms", "geo_floor_ms",
  "creep_fp_id", "fpjs_id", "creep_lies", "creep_headless_pct", "creep_stealth_pct", "worker_type",
  "verified_agent", "declared_bot", "suspected_agent", "anti_detect", "agent_score", "antidetect_score", ...flagIds];
const csv = (x) => (x === null || x === undefined ? "" : /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : String(x));
const rows = visits.map((v) => {
  const s = v.server || {}, d = v.verdict || {}, h = d.hop || {}, g = s.geo || {};
  const cr = v.client?.raw?.creep || {};
  const fired = new Set((d.flags || []).map((f) => f.id));
  const rel = (t) => (t && v.t0 ? t - v.t0 : null);
  return [v.id, v.cohort, v.tool, rel(v.t1), rel(v.t3), rel(v.t5), g.country, g.asn, g.asOrg, g.hosting,
    s.ja4, s.ja4h, s.ja4t, s.synTtl, s.synHops, h.tcpRttMs, h.pageRttMinMs, h.gapMs, h.geoFloorMs,
    cr.fpId, v.client?.raw?.fpjs?.visitorId, cr.lies?.total, cr.headless?.headless, cr.headless?.stealth, cr.worker?.type,
    d.verifiedAgent, d.declaredBot?.status ? `${d.declaredBot.token}:${d.declaredBot.status}` : "",
    d.suspectedAgent ? 1 : 0, d.antiDetect ? 1 : 0, d.agentScore, d.antiDetectScore,
    ...flagIds.map((id) => (fired.has(id) ? 1 : 0))].map(csv).join(",");
});
fs.writeFileSync(path.join(outDir, "visits.csv"), [cols.join(","), ...rows].join("\n") + "\n");

// Grading table: share of each cohort's visits on which each flag fired.
const cohorts = [...new Set(visits.map((v) => v.cohort || "unlabeled"))].sort();
const byCohort = Object.fromEntries(cohorts.map((c) => [c, visits.filter((v) => (v.cohort || "unlabeled") === c)]));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
console.log(`\n${visits.length} visits -> ${path.resolve(outDir)}/visits.csv, visits.jsonl\n`);
console.log(`| Flag | ${cohorts.map((c) => `${c} (n=${byCohort[c].length})`).join(" | ")} |`);
console.log(`|---|${cohorts.map(() => "---").join("|")}|`);
for (const id of flagIds) {
  console.log(`| ${id} | ${cohorts.map((c) => pct(byCohort[c].filter((v) => (v.verdict?.flags || []).some((f) => f.id === id)).length, byCohort[c].length)).join(" | ")} |`);
}
for (const k of ["suspectedAgent", "antiDetect"]) {
  console.log(`| **verdict: ${k}** | ${cohorts.map((c) => pct(byCohort[c].filter((v) => v.verdict?.[k]).length, byCohort[c].length)).join(" | ")} |`);
}
