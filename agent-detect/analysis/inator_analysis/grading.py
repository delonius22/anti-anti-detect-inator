"""Signal grading, as defined in the test plan's "Scoring, metrics and exit criteria".

A signal is judged by how often it fires on the cohorts it is meant to catch
(its target) versus real people (C1) and privacy browsers (C2):

    Strong      target >= 90%   C1 <= 1%   C2 <= 5%    can drive a verdict alone
    Supporting  target >= 50%   C1 <= 5%   C2 <= 15%   adds weight only
    Dropped     anything else                          logged, never scored
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .load import COHORTS, FLAG_PREFIX

# Which cohorts each side of a flag is meant to catch.
TARGETS = {
    "agent": ("C3", "C4", "C5"),
    "antidetect": ("C6",),
    "both": ("C3", "C4", "C5", "C6"),
}


@dataclass(frozen=True)
class GradeRule:
    target_min: float
    c1_max: float
    c2_max: float


STRONG = GradeRule(0.90, 0.01, 0.05)
SUPPORTING = GradeRule(0.50, 0.05, 0.15)
MIN_N = 30  # sessions per cohort the plan asks for before trusting a rate


def _rate(df: pd.DataFrame, col: str, cohorts) -> tuple[float, int]:
    sub = df[df["cohort"].isin(cohorts)]
    n = len(sub)
    return (float(sub[col].mean()) if n else float("nan")), n


def grade_one(target: float, c1: float, c2: float) -> str:
    def ok(rule: GradeRule) -> bool:
        return (target >= rule.target_min
                and (pd.isna(c1) or c1 <= rule.c1_max)
                and (pd.isna(c2) or c2 <= rule.c2_max))
    if pd.isna(target):
        return "no target data"
    if ok(STRONG):
        return "strong"
    if ok(SUPPORTING):
        return "supporting"
    return "dropped"


def grade_signals(df: pd.DataFrame, min_n: int = MIN_N) -> pd.DataFrame:
    """One row per flag.

    A signal is usually built to catch one kind of tool (webdriver catches
    Playwright, not Comet), so pooling every target cohort would bury it. The
    grade uses the best-caught *tool* among the flag's target cohorts that has
    at least `min_n` visits (falling back to the best tool of any size, marked
    low n). The pooled target rate is shown alongside for context."""
    rows = []
    for fid, side in df.attrs.get("flag_sides", {}).items():
        col = FLAG_PREFIX + fid
        targets = TARGETS.get(side, TARGETS["both"])
        pooled, n_t = _rate(df, col, targets)
        tdf = df[df["cohort"].isin(targets)]
        by_tool = tdf.groupby("tool")[col].agg(["mean", "count"]) if len(tdf) else pd.DataFrame(columns=["mean", "count"])
        sized = by_tool[by_tool["count"] >= min_n]
        pick = sized if len(sized) else by_tool
        if len(pick):
            best_tool = pick["mean"].idxmax(); best_rate = float(pick.loc[best_tool, "mean"]); best_n = int(pick.loc[best_tool, "count"])
        else:
            best_tool, best_rate, best_n = None, float("nan"), 0
        c1, n1 = _rate(df, col, ("C1",))
        c2, n2 = _rate(df, col, ("C2",))
        low = [name for name, n in (("best tool", best_n), ("C1", n1), ("C2", n2)) if n < min_n]
        rows.append({
            "flag": fid, "side": side, "target_cohorts": "+".join(targets),
            "best_tool": best_tool, "best_tool_rate": best_rate, "pooled_target_rate": pooled,
            "c1_rate": c1, "c2_rate": c2, "n_best_tool": best_n, "n_c1": n1, "n_c2": n2,
            "grade": grade_one(best_rate, c1, c2),
            "low_n": ", ".join(low),
        })
    out = pd.DataFrame(rows, columns=["flag", "side", "target_cohorts", "best_tool", "best_tool_rate",
                                      "pooled_target_rate", "c1_rate", "c2_rate", "n_best_tool", "n_c1", "n_c2",
                                      "grade", "low_n"])
    order = {"strong": 0, "supporting": 1, "dropped": 2, "no target data": 3}
    out["_o"] = out["grade"].map(order)
    return out.sort_values(["_o", "best_tool_rate"], ascending=[True, False]).drop(columns="_o").reset_index(drop=True)


def rates_by_cohort(df: pd.DataFrame) -> pd.DataFrame:
    """Share of each cohort's visits on which each flag fired (the grading table, wide)."""
    cols = [FLAG_PREFIX + f for f in df.attrs.get("flag_sides", {})]
    present = [c for c in (*COHORTS, "unlabeled") if c in set(df["cohort"])]
    if not cols or not present:
        return pd.DataFrame()
    t = df.groupby("cohort")[cols].mean().T.reindex(columns=present)
    t.index = [c[len(FLAG_PREFIX):] for c in t.index]
    t.loc["(visits)"] = df["cohort"].value_counts().reindex(present)
    return t
