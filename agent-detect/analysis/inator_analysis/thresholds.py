"""Thresholds the test plan says to set from data, not guesses.

H4 RTT gap: the plan sets the gap threshold from the C1 and C2 distributions.
This suggests the 99th percentile of human + privacy-browser gaps, so roughly
1 in 100 legitimate visits would trip it before any other signal is counted.
"""
from __future__ import annotations

import pandas as pd

QUANTILES = (0.5, 0.9, 0.99)


def distribution(df: pd.DataFrame, col: str) -> pd.DataFrame:
    """Median, p90, p99 and count of `col` per cohort."""
    if df.empty or col not in df:
        return pd.DataFrame()
    d = df[df[col].notna()]
    if d.empty:
        return pd.DataFrame()
    q = d.groupby("cohort")[col].quantile(list(QUANTILES)).unstack()
    q.columns = [f"p{int(x * 100)}" for x in QUANTILES]
    q["n"] = d.groupby("cohort")[col].count()
    return q


def suggest_rtt_gap_ms(df: pd.DataFrame, quantile: float = 0.99, min_n: int = 30) -> dict:
    legit = df[df["cohort"].isin(["C1", "C2"]) & df["gap_ms"].notna()]["gap_ms"]
    if len(legit) < min_n:
        return {"value": None, "n": int(len(legit)),
                "note": f"need at least {min_n} C1/C2 visits with RTT samples; have {len(legit)}"}
    v = max(int(round(float(legit.quantile(quantile)))), 1)
    return {"value": v, "n": int(len(legit)),
            "note": f"p{int(quantile * 100)} of C1+C2 gaps; set RTT_GAP_MS={v} in /etc/capture-app.env"}


def geo_floor_ratio(df: pd.DataFrame) -> pd.DataFrame:
    """TCP RTT divided by the speed-of-light floor, per cohort. Real visitors sit
    above 1.0; values under 0.9 are what H5 flags."""
    d = df[df["geo_floor_ms"].notna() & (df["geo_floor_ms"] >= 5) & df["tcp_rtt_ms"].notna()].copy()
    if d.empty:
        return pd.DataFrame()
    d["ratio"] = d["tcp_rtt_ms"] / d["geo_floor_ms"]
    return distribution(d, "ratio")
