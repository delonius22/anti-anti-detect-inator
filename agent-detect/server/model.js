// The "System 1" model at run time: human / agent / anti-detect percentages for
// each visit, computed locally from model.json (trained by the Python toolkit:
// python -m inator_analysis report ... writes model.json).
//
// Turn it on with MODEL_FILE=/var/lib/capture-app/model.json. Optional
// MODEL_PRIORS="human=0.97,agent=0.02,antidetect=0.01" shifts the percentages
// from the lab's cohort mix to the mix you expect in real traffic.
// Features are rebuilt exactly as analysis/inator_analysis/model.py builds them;
// test/model.test.js checks the two agree to many decimal places.

import fs from "node:fs";

let MODEL = null;
let PRIORS = null;

export function parsePriors(s) {
  if (!s) return null;
  const out = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k && Number(v) > 0) out[k] = Number(v);
  }
  return Object.keys(out).length ? out : null;
}

export function setModel(model, priors = null) {
  if (model && model.format !== "inator-logistic-v1") throw new Error(`unknown model format: ${model.format}`);
  MODEL = model;
  PRIORS = priors;
}

export function loadModel(file = process.env.MODEL_FILE, priors = process.env.MODEL_PRIORS) {
  if (!file) return null;
  try {
    setModel(JSON.parse(fs.readFileSync(file, "utf8")), parsePriors(priors));
    console.log(`model: loaded ${file} (${MODEL.features.length} features, trained ${MODEL.trained_at || "?"})`);
  } catch (e) {
    console.error(`model: not loaded (${e.message}); verdicts continue without percentages`);
    MODEL = null;
  }
  return MODEL;
}

export const modelLoaded = () => MODEL !== null;

// Raw numeric inputs, keyed by the feature names model.py uses.
function rawNumbers(v) {
  const s = v.server || {}, c = v.client || null, h = v.hop || {};
  const beh = c?.behaviour || {};
  const probes = c?.raw?.creep && !c.raw.creep.error ? c.raw.creep : null;
  return {
    js_ran: Array.isArray(c?.flags) ? 1 : 0,
    clicked: beh.click ? 1 : 0,
    hosting: s.geo?.hosting ? 1 : 0,
    log_gap_ms: h.gapMs,
    log_tcp_rtt_ms: Number.isFinite(s.tcpRttUs) ? s.tcpRttUs / 1000 : null,
    syn_hops: s.synHops,
    log_moves: beh.moves,
    click_offset_px: beh.click?.offsetPx,
    probes_ran: probes ? 1 : 0,
    log_creep_lies: probes ? probes.lies?.total : null,
    creep_headless_pct: probes ? probes.headless?.headless : null,
    creep_stealth_pct: probes ? probes.headless?.stealth : null,
  };
}

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// v = { flags: [flag ids], server, client, hop }
export function modelFeatures(v, model = MODEL) {
  const fired = new Set(v.flags || []);
  const raw = rawNumbers(v);
  const missing = {};
  return model.features.map((f) => {
    if (f.kind === "flag") return fired.has(f.id) ? 1 : 0;
    if (f.kind === "missing") return missing[f.of] ? 1 : 0;
    const x = raw[f.name];
    if (f.transform === "bool") { missing[f.name] = !isNum(x); return isNum(x) ? Math.min(Math.max(x, 0), 1) : 0; }
    missing[f.name] = !isNum(x);
    if (!isNum(x)) return 0;
    const clipped = Math.min(Math.max(x, 0), f.cap);
    return f.transform === "log1p" ? Math.log1p(clipped) : clipped;
  });
}

function reasonLabel(f, x, z) {
  const name = f.name.replace(/^flag:/, "");
  if (f.kind === "flag" || f.kind === "missing" || f.transform === "bool") return x > 0 ? name : `no ${name}`;
  return `${z > 0 ? "high" : "low"} ${name}`;
}

export function predict(v, { model = MODEL, priors = PRIORS, k = 3 } = {}) {
  if (!model) return null;
  const x = modelFeatures(v, model);
  const z = x.map((xi, j) => (xi - model.mean[j]) / model.scale[j]);
  const C = model.classes.length;
  const logits = model.coef.map((row, c) => (row.reduce((a, w, j) => a + w * z[j], model.intercept[c])) / model.temperature);
  if (priors) model.classes.forEach((cls, c) => {
    if (priors[cls] && model.train_priors[cls]) logits[c] += Math.log(priors[cls] / model.train_priors[cls]);
  });
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const sum = e.reduce((a, b) => a + b, 0);
  const p = e.map((ei) => ei / sum);
  const top = p.indexOf(Math.max(...p));

  const meanCoef = model.coef[0].map((_, j) => model.coef.reduce((a, row) => a + row[j], 0) / C);
  const contrib = z.map((zj, j) => ({ j, v: zj * (model.coef[top][j] - meanCoef[j]) })).sort((a, b) => b.v - a.v);
  const reasons = contrib.slice(0, k).filter((c) => c.v > 0.05).map((c) => reasonLabel(model.features[c.j], x[c.j], z[c.j]));

  const probabilities = Object.fromEntries(model.classes.map((cls, c) => [cls, +p[c].toFixed(4)]));
  return {
    probabilities,
    tag: p[top] < (model.uncertain_below ?? 0.6) ? "uncertain" : model.classes[top],
    reasons,
    priors: priors ? "live" : "training mix",
  };
}

// Exact (unrounded) probabilities, for the parity test.
export function predictRaw(v, model = MODEL) {
  const x = modelFeatures(v, model);
  const z = x.map((xi, j) => (xi - model.mean[j]) / model.scale[j]);
  const logits = model.coef.map((row, c) => row.reduce((a, w, j) => a + w * z[j], model.intercept[c]) / model.temperature);
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const s = e.reduce((a, b) => a + b, 0);
  return Object.fromEntries(model.classes.map((cls, c) => [cls, e[c] / s]));
}
