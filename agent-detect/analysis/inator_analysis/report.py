"""Builds the Phase 6 report: report.md plus CSVs and two charts in one folder."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import charts
from .exit_criteria import completeness, evaluate
from .fit import confusion, fit_all
from .grading import grade_signals, rates_by_cohort
from .load import load
from .model import CLASSES, parity_cases, save_model, tag_visits, train_and_evaluate
from .population import device_linkage, id_linkage, tool_traces, velocity
from .rarity import attribute_entropy, by_cohort, impossible_combinations, impossible_rates, surprisal
from .thresholds import distribution, geo_floor_ratio, suggest_rtt_gap_ms


def _pct(x) -> str:
    return "" if pd.isna(x) else f"{x:.0%}"


def _md(df: pd.DataFrame, pct_cols=(), max_rows: int | None = None) -> str:
    if df is None or df.empty:
        return "_No data._"
    d = df.copy() if max_rows is None else df.head(max_rows).copy()
    for c in pct_cols:
        if c in d:
            d[c] = d[c].map(_pct)
    d = d.fillna("")
    cols = [str(c) for c in d.columns]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for row in d.itertuples(index=False):
        lines.append("| " + " | ".join(str(v).replace("|", "\\|") for v in row) + " |")
    return "\n".join(lines)


def build_report(source: str | Path, out_dir: str | Path, precision_target: float = 0.98,
                 min_n: int = 30, allow_negative: bool = False, priors: dict | None = None) -> Path:
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    df = load(source)
    if df.empty:
        (out / "report.md").write_text("# Phase 6 report\n\nNo visits found.\n")
        return out / "report.md"

    grades = grade_signals(df, min_n=min_n)
    wide = rates_by_cohort(df)
    fits = fit_all(df, precision_target=precision_target, allow_negative=allow_negative)
    crit = evaluate(df, fits, precision_target=precision_target)
    comp = completeness(df)
    gap = suggest_rtt_gap_ms(df, min_n=min_n)
    link = device_linkage(df)
    traces = tool_traces(df)
    vel_ja4, vel_asn = velocity(df, "ja4"), velocity(df, "asn")
    idlink = id_linkage(df)
    ent = attribute_entropy(df)
    sur = surprisal(df)
    imp = impossible_combinations(df)
    rare = sur.merge(imp[["visit_id", "impossible_pairs", "impossible_detail"]], on="visit_id")
    imp_rates = impossible_rates(imp)

    grades.to_csv(out / "signal_grades.csv", index=False)
    wide.to_csv(out / "flag_rates_by_cohort.csv")
    link.to_csv(out / "device_linkage.csv", index=False)
    traces.to_csv(out / "tool_traces.csv", index=False)
    idlink.to_csv(out / "id_linkage.csv", index=False)
    ent.to_csv(out / "attribute_entropy.csv", index=False)
    rare.to_csv(out / "rarity_by_visit.csv", index=False)
    crit.to_csv(out / "exit_criteria.csv", index=False)
    weights = {k: {"threshold": f.threshold, "weights": f.weights, "negative_coefficients": f.negative,
                   "split": f.split, "test": f.test, "message": f.message} for k, f in fits.items()}
    (out / "weights.json").write_text(json.dumps(weights, indent=2, default=float))
    mrep = train_and_evaluate(df)
    tags = None
    if mrep.ok:
        save_model(mrep, out / "model.json")
        (out / "parity.json").write_text(json.dumps(parity_cases(df, mrep.exported), indent=1, default=float))
        tags = tag_visits(df, mrep, priors=priors).merge(
            rare[["visit_id", "surprisal_bits_mean", "surprisal_pct_vs_people", "unseen_values", "impossible_pairs",
                  "impossible_detail"]], on="visit_id", how="left")
        tags.to_csv(out / "tags.csv", index=False)
    g_png = charts.grading_chart(grades, out / "signal_grades.png")
    h_png = charts.gap_chart(df, gap["value"], out / "rtt_gap.png")

    dates = sorted(d for d in df["run_date"].dropna().unique())
    cohort_counts = df.groupby(["cohort", "tool"]).size().rename("visits").reset_index()
    passed = (crit["status"] == "PASS").sum()

    parts = [
        "# Phase 6 report: the Anti-Anti-Detect-inator",
        f"Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC from `{Path(source).name}`. "
        f"{len(df)} visits, run dates {dates[0] if dates else '?'} to {dates[-1] if dates else '?'}.",
        f"**Exit criteria: {passed} of {len(crit)} pass.** Enforcement rules wait until all pass.",
        "## Exit criteria", _md(crit),
        "## Data by cohort and tool",
        f"The plan asks for at least {min_n} visits per configuration before a rate is trusted.",
        _md(cohort_counts),
        "## Signal grades",
        "Graded on the best-caught tool in the flag's target cohorts, against C1 (people) and C2 (privacy browsers). "
        "Strong: target >= 90%, C1 <= 1%, C2 <= 5%. Supporting: target >= 50%, C1 <= 5%, C2 <= 15%.",
        f"![Signal grades]({g_png.name})" if g_png else "",
        _md(grades[["flag", "side", "best_tool", "best_tool_rate", "pooled_target_rate", "c1_rate", "c2_rate", "grade", "low_n"]],
            pct_cols=("best_tool_rate", "pooled_target_rate", "c1_rate", "c2_rate")),
        "Full per-cohort rates: `flag_rates_by_cohort.csv`.",
        "## Fitted weights",
        "Logistic regression on earlier runs, tested on later runs, converted to the integer weights and threshold the Node scorer uses. "
        "Negative coefficients are clamped to 0 so no visitor can lower its score by triggering a signal on purpose.",
    ]
    for name, f in fits.items():
        parts.append(f"### {'Suspected agent' if name == 'agent' else 'Anti-detect'}")
        if not f.ok:
            parts.append(f"_Not fitted: {f.message}_")
            continue
        t = f.test
        parts.append(f"Split {f.split}. {f.n_train} visits to fit, {f.n_test} to test. "
                     f"Threshold **{f.threshold}**. Held-out precision {_pct(t.get('precision'))}, recall {_pct(t.get('recall'))}, "
                     f"C1 false positives {_pct(t.get('fpr_c1'))}, C2 false positives {_pct(t.get('fpr_c2'))}"
                     + (f", AUC {f.auc_test:.3f}" if not pd.isna(f.auc_test) else "") + ".")
        if f.current:
            c = f.current
            parts.append(f"The current Node weights on the same held-out visits: precision {_pct(c.get('precision'))}, "
                         f"recall {_pct(c.get('recall'))}, C2 false positives {_pct(c.get('fpr_c2'))}.")
        w = pd.DataFrame(sorted(f.weights.items(), key=lambda kv: -kv[1]), columns=["flag", "weight"])
        parts.append(_md(w))
        if f.negative:
            parts.append("Looked more like people than targets (clamped to 0; consider dropping): "
                         + ", ".join(f"`{k}`" for k in sorted(f.negative)) + ".")
    parts += ["## System 1 model: percentages per visit"]
    if not mrep.ok:
        parts.append(f"_Not trained: {mrep.message}_")
    else:
        rows = []
        for name, m in mrep.holdout.items():
            rows.append({"model": name + (" (exported to Node)" if name == "logistic" else ""),
                         "log loss": round(m["log_loss"], 3), "Brier": round(m["brier"], 3),
                         "calibration error": _pct(m["ece"]), "accuracy": _pct(m["accuracy"]),
                         **{f"precision {c}": _pct(m[f"precision_{c}"]) for c in CLASSES},
                         **{f"recall {c}": _pct(m[f"recall_{c}"]) for c in CLASSES}})
        parts += [
            "A calibrated classifier gives every visit a percentage for human, agent and anti-detect. "
            f"Held-out runs ({mrep.split}; {mrep.n_train} visits to fit, {mrep.n_test} to test). Lower log loss and Brier are better; "
            "calibration error is how far stated percentages sit from how often they were right.",
            _md(pd.DataFrame(rows)),
            f"`tags.csv` uses the **{mrep.chosen_for_tagging}** model (lower held-out log loss). "
            "Reliability of the exported model on held-out runs: when it said about X%, how often was it right?",
            _md(mrep.calibration["logistic"], pct_cols=("mean_stated", "actually_right")),
            "Tags by cohort (`uncertain` = top class under 60%; a verified signature always wins):",
            _md(tags.groupby(["cohort", "tag"]).size().unstack(fill_value=0).reset_index()) if tags is not None else "",
            "**Percentages reflect the cohort mix you tested with.** Real traffic is mostly people, so set the expected mix "
            "before trusting live numbers: `--priors human=0.97,agent=0.02,antidetect=0.01` here, `MODEL_PRIORS` in Node.",
            "**Live in Node:** copy `model.json` to the server and set `MODEL_FILE=/var/lib/capture-app/model.json` in "
            "`/etc/capture-app.env`, then restart the app. Every verdict gains `model.probabilities`, `model.tag` and "
            "`model.reasons`. `parity.json` lets `npm run test:model` confirm Node matches Python.",
        ]
    parts += [
        "## Applying the fitted weights",
        "To apply: set each flag's `w:` in `client/stop.js` (page checks) or `server/scoring.js` (server checks), "
        "and set `THRESHOLDS.suspectedAgent` / `THRESHOLDS.antiDetect` to the thresholds above. Full values: `weights.json`.",
        "## Thresholds from data",
        f"**RTT gap (H4):** {gap['note']}.",
        f"![RTT gap by cohort]({h_png.name})" if h_png else "",
        _md(distribution(df, "gap_ms").round(1).reset_index()),
        "**Speed-of-light ratio (H5):** TCP round-trip divided by the physical floor. H5 flags values under 0.9.",
        _md(geo_floor_ratio(df).round(2).reset_index()),
        "## Population checks",
        "### P1 device linkage",
        "Visits sharing every stable value (JA4T, TTL, GPU, fonts, network, CPU count) inside one day while claiming several identities. "
        "Leads to inspect, not verdicts: two people with the same laptop on the same ISP can collide.",
        _md(link, max_rows=20),
        "### P1 by device ID (CreepJS and FingerprintJS)",
        "Visits sharing a CreepJS stable ID or a FingerprintJS visitor ID while claiming several user agents or IPs. "
        "CreepJS leaves components it caught lying out of its stable ID, so a rotating profile often keeps one ID.",
        _md(idlink, max_rows=20),
        "### P2 velocity",
        "Busiest hours per JA4 and per network, with C1's 99th-percentile hourly count for scale.",
        _md(vel_ja4, max_rows=10), _md(vel_asn, max_rows=10),
        "### P3 tool traces",
        "Values seen in at least 80% of one tool's visits and at most 1% of everyone else's.",
        _md(traces, pct_cols=("share_in_tool", "share_elsewhere"), max_rows=40),
        "## Rarity and impossible combinations",
        "Measured against C1 and C2 with leave-one-out (a visit is never compared with itself). "
        "**Surprisal** is the average -log2 P(value) per attribute; values no person showed cost the most. "
        "**Impossible pairs** are two coarse values that each appear among people at least 3 times but never together "
        "(for example a macOS user agent with an NVIDIA GPU). With a small reference set, rare real setups land here too: "
        "read both as rankings until C1/C2 hold a few hundred visits. Per visit: `rarity_by_visit.csv`; also in `tags.csv`.",
        _md(by_cohort(sur, imp), pct_cols=("any_unseen_value", "any_impossible_pair")),
        "Share of each cohort's visits with each impossible pair:",
        _md(imp_rates.reset_index() if not imp_rates.empty else None),
        "Attribute entropy among people (bits; higher = more identifying). `unique_share` is the share of people whose "
        "value nobody else had. Full table: `attribute_entropy.csv`.",
        _md(ent, pct_cols=("unique_share", "present_all"), max_rows=20),
        "## Current verdicts by cohort",
        "What the Node scorer stored, before any reweighting.",
        _md(confusion(df).reset_index()),
        "## Capture completeness",
        _md(comp, pct_cols=("complete",)),
    ]
    path = out / "report.md"
    path.write_text("\n\n".join(p for p in parts if p) + "\n", encoding="utf-8")
    return path
