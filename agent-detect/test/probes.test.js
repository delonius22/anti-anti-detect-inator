// Unit checks for the probe pieces that run on the server: the C12 worker-UA
// check, device IDs on the verdict, the probe numbers the model reads, and that
// the built bundle still carries its attribution and none of CreepJS's network calls.
//   node test/probes.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeVerdict, probeFlags } from "../server/scoring.js";
import { modelFeatures } from "../server/model.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, info = "") => results.push([ok ? "PASS" : "FAIL", name, info]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const creep = (worker) => ({ fpId: "a".repeat(64), fuzzy: "b".repeat(64), lies: { total: 7 }, headless: { headless: 33, stealth: 20 }, worker });

check("C12 fires when the service worker's UA differs from the request's",
  probeFlags({ userAgent: UA }, { raw: { creep: creep({ type: "service", userAgent: UA.replace("Windows NT 10.0; Win64; x64", "X11; Linux x86_64") }) } })
    .some((f) => f.id === "C12-worker-ua-vs-http-ua"));
check("C12 quiet when they match", probeFlags({ userAgent: UA }, { raw: { creep: creep({ type: "service", userAgent: UA }) } }).length === 0);
check("C12 ignores dedicated workers (emulators control those)",
  probeFlags({ userAgent: UA }, { raw: { creep: creep({ type: "dedicated", userAgent: "x" }) } }).length === 0);
check("C12 compares only the 300 characters probes.js keeps",
  probeFlags({ userAgent: UA + "x".repeat(400) }, { raw: { creep: creep({ type: "service", userAgent: (UA + "x".repeat(400)).slice(0, 300) }) } }).length === 0);

const v = computeVerdict({ server: { userAgent: UA }, client: { flags: [], raw: { creep: creep({ type: "service", userAgent: UA }), fpjs: { visitorId: "c".repeat(32) } } } });
check("verdict carries CreepJS and FingerprintJS IDs", v.ids.creep === "a".repeat(64) && v.ids.fpjs === "c".repeat(32), JSON.stringify(v.ids).slice(0, 80));

const spec = { features: [
  { name: "probes_ran", kind: "num", transform: "bool" },
  { name: "log_creep_lies", kind: "num", transform: "log1p", cap: 500 },
  { name: "creep_headless_pct", kind: "num", transform: "clip", cap: 100 },
  { name: "creep_stealth_pct", kind: "num", transform: "clip", cap: 100 }] };
const x = modelFeatures({ flags: [], server: {}, client: { flags: [], raw: { creep: creep(null) } }, hop: {} }, spec);
check("model reads probe numbers", x[0] === 1 && Math.abs(x[1] - Math.log1p(7)) < 1e-12 && x[2] === 33 && x[3] === 20, JSON.stringify(x));
const y = modelFeatures({ flags: [], server: {}, client: { flags: [], raw: { creep: { error: "timeout" } } }, hop: {} }, spec);
check("failed probes count as not run", y.every((n) => n === 0), JSON.stringify(y));

const bundle = fs.readFileSync(path.join(root, "client/probes.js"), "utf8");
check("bundle keeps the CreepJS MIT attribution", /Based on CreepJS[\s\S]*MIT License, Copyright \(c\) Abraham Juliot/.test(bundle.slice(0, 600)));
check("bundle has no fetch/XHR/sendBeacon calls (samples and script-size calls left out)",
  !/\bfetch\(|new XMLHttpRequest|\.sendBeacon\(/.test(bundle));
check("bundle registers its workers from /probes.js", bundle.includes("'/probes.js'") || bundle.includes('"/probes.js"'));
// FingerprintJS's npm build has one network call: a 0.1%-sampled "npm-monitoring"
// ping to m1.openfpcdn.io, skipped when load() gets { monitoring: false }.
const fpjs = fs.readFileSync(path.join(root, "node_modules/@fingerprintjs/fingerprintjs/dist/fp.umd.min.js"), "utf8");
const calls = fpjs.match(/new XMLHttpRequest|\bfetch\(|\.sendBeacon\(/g) || [];
check("FingerprintJS's only network call is the monitoring ping", calls.length === 1 && fpjs.includes("npm-monitoring"), String(calls.length));
const stop = fs.readFileSync(path.join(root, "client/stop.js"), "utf8");
check("stop.js turns FingerprintJS monitoring off", stop.includes("FingerprintJS.load({ monitoring: false })") && stop.includes("__fpjs_d_m = true"));

for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
