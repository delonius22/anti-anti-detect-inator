// Node must reproduce the Python model exactly. Uses model.json + parity.json
// written by `python -m inator_analysis report` (defaults: analysis/example-report).
//   MODEL_DIR=phase6 node test/model.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setModel, predict, predictRaw, parsePriors } from "../server/model.js";
import { computeVerdict } from "../server/scoring.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.MODEL_DIR || path.join(root, "analysis", "example-report");
const model = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
const cases = JSON.parse(fs.readFileSync(path.join(dir, "parity.json"), "utf8"));
const results = [];
const t = (name, fn) => { try { fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); } };

setModel(model);

t(`Node matches Python on ${cases.length} visits (to 1e-9)`, () => {
  let worst = 0;
  for (const c of cases) {
    const p = predictRaw(c.visit, model);
    for (const k of model.classes) worst = Math.max(worst, Math.abs(p[k] - c.expected[k]));
  }
  assert.ok(worst < 1e-9, `worst difference ${worst}`);
});

t("probabilities sum to 1 and a tag is given", () => {
  const r = predict(cases[0].visit);
  const s = Object.values(r.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-3);
  assert.ok(["human", "agent", "antidetect", "uncertain"].includes(r.tag));
});

t("live priors move percentages toward 'human'", () => {
  const v = cases.find((c) => c.expected.agent > 0.5 && c.expected.agent < 0.999)?.visit || cases[0].visit;
  const lab = predict(v, { model, priors: null }).probabilities.human;
  const live = predict(v, { model, priors: parsePriors("human=0.97,agent=0.02,antidetect=0.01") }).probabilities.human;
  assert.ok(live >= lab, `${live} < ${lab}`);
});

t("computeVerdict carries model output, and a verified signature wins the tag", () => {
  const visit = {
    server: { signature: { type: "verified-agent", agent: "chatgpt" }, tcpRttUs: 9000, synHops: 9, geo: { hosting: true } },
    client: { flags: [{ id: "J4-software-gpu", side: "agent", w: 2 }], behaviour: { moves: 0 } },
    rtt: { samplesMs: [12, 13, 12.5], tcpRttUsWs: 9000 },
  };
  const v = computeVerdict(visit);
  assert.ok(v.model && v.model.probabilities);
  assert.equal(v.model.tag, "agent (verified: chatgpt)");
});

t("no model loaded: verdict has model = null", () => {
  setModel(null);
  assert.equal(computeVerdict({ server: {}, client: null }).model, null);
});

for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
