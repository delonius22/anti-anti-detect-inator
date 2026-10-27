"""The test plan's exit criteria, checked against the data.

All five must pass before any enforcement rule is written:
1. N1 verifies 100% of signed C3 sessions (and accepts no forged ones)
2. Capture completeness >= 99% for every Phase 1-4 field
3. Precision >= 98% for suspected-agent and anti-detect on the hold-out set
4. False-positive rate <= 2% on C2 privacy browsers
5. Results reproduced on a second run at least four weeks after the first
"""
from __future__ import annotations

import pandas as pd

from .fit import FitResult
from .grading import grade_signals

# Phase 1-4 fields and which visits they must exist for.
FIELDS = {
    "ja4": "all", "ja4h": "all", "ja4t": "all", "syn_ttl": "all", "tcp_rtt_ms": "all",
    "t1_ms": "all",
    "page_rtt_min_ms": "js",   # needs the page script, so not expected from C5 fetchers
    "webgl_renderer": "js",
    "t3_ms": "js",
}


def completeness(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for f, scope in FIELDS.items():
        if f not in df:
            continue
        base = df if scope == "all" else df[df["js_ran"]]
        n = len(base)
        rate = float(base[f].notna().mean()) if n else float("nan")
        rows.append({"field": f, "scope": "all visits" if scope == "all" else "visits that ran JavaScript",
                     "n": n, "complete": rate})
    return pd.DataFrame(rows)


def evaluate(df: pd.DataFrame, fits: dict[str, FitResult], precision_target: float = 0.98,
             c2_fpr_max: float = 0.02, completeness_min: float = 0.99, repro_days: int = 28) -> pd.DataFrame:
    rows = []

    # 1. Web Bot Auth on C3: every request that carried signature headers must verify.
    c3 = df[df["cohort"] == "C3"]
    signed = c3[c3["signature_type"].isin(["verified-agent", "claimed-agent"])]
    if len(signed):
        rate = float((signed["signature_type"] == "verified-agent").mean())
        rows.append(("N1 verifies all signed C3 sessions", rate == 1.0,
                     f"{rate:.0%} of {len(signed)} signed C3 visits verified; forged and replayed cases are covered by `npm test`"))
    else:
        rows.append(("N1 verifies all signed C3 sessions", None, "no signed C3 visits yet"))

    # 2. Completeness.
    comp = completeness(df)
    low = comp[comp["complete"] < completeness_min]
    rows.append((f"Capture completeness >= {completeness_min:.0%}", len(comp) > 0 and low.empty,
                 "all fields complete" if len(comp) and low.empty
                 else "; ".join(f"{r.field} {r.complete:.1%}" for r in low.itertuples()) or "no data"))

    # 3 and 4. Precision and C2 false positives, from the fitted integer scorer on held-out runs.
    for name, label in (("agent", "suspected-agent"), ("antidetect", "anti-detect")):
        fr = fits.get(name)
        if not fr or not fr.ok or not fr.test:
            rows.append((f"Precision >= {precision_target:.0%} for {label} (hold-out)", None,
                         fr.message if fr else "not fitted"))
            rows.append((f"C2 false positives <= {c2_fpr_max:.0%} for {label}", None, fr.message if fr else "not fitted"))
            continue
        p, c2 = fr.test["precision"], fr.test["fpr_c2"]
        rows.append((f"Precision >= {precision_target:.0%} for {label} (hold-out)",
                     None if pd.isna(p) else p >= precision_target,
                     f"{p:.1%} on {fr.n_test} held-out visits ({fr.split})" if not pd.isna(p) else "no positives predicted"))
        rows.append((f"C2 false positives <= {c2_fpr_max:.0%} for {label}",
                     None if pd.isna(c2) else c2 <= c2_fpr_max,
                     f"{c2:.1%} of held-out C2 visits" if not pd.isna(c2) else "no C2 visits in the hold-out runs"))

    # 5. Reproduction: grades hold up between the first and last run windows, >= 4 weeks apart.
    dates = sorted(d for d in df["run_date"].dropna().unique())
    if len(dates) >= 2 and (pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])).days >= repro_days:
        mid = pd.Timestamp(dates[0]) + (pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])) / 2
        a = df[pd.to_datetime(df["run_date"]) <= mid]; b = df[pd.to_datetime(df["run_date"]) > mid]
        a.attrs = b.attrs = df.attrs
        ga, gb = grade_signals(a).set_index("flag")["grade"], grade_signals(b).set_index("flag")["grade"]
        kept = ga[ga.isin(["strong", "supporting"])].index
        fell = [f for f in kept if gb.get(f) not in ("strong", "supporting")]
        if len(kept) == 0:
            rows.append((f"Reproduced on a run {repro_days}+ days later", None,
                         "no strong or supporting signals in the first window to compare"))
        else:
            rows.append((f"Reproduced on a run {repro_days}+ days later", not fell,
                         f"{len(kept)} strong or supporting signals in the first window; "
                         + (f"dropped later: {', '.join(fell)}" if fell else "all still strong or supporting later")))
    else:
        span = (pd.Timestamp(dates[-1]) - pd.Timestamp(dates[0])).days if len(dates) >= 2 else 0
        rows.append((f"Reproduced on a run {repro_days}+ days later", None, f"runs span {span} days so far"))

    out = pd.DataFrame(rows, columns=["criterion", "passed", "detail"])
    out["status"] = out["passed"].map({True: "PASS", False: "FAIL"}).fillna("NOT YET")
    return out[["criterion", "status", "detail"]]
