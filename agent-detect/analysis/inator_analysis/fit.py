"""Fit scorer weights from labeled runs and test them on held-out runs.

Two models, matching the Node scorer's two suspicion verdicts:
    agent       positives C3+C4+C5, negatives C1+C2, features = agent + both flags
    antidetect  positives C6,       negatives C1+C2, features = antidetect + both flags

Hold-out follows the plan: split by run date, earlier 70% of run dates for
fitting, later 30% for testing, so no run sits in both halves (and the test
also shows drift). The logistic regression is then turned into integer
weights and an integer threshold, the form server/scoring.js and
client/stop.js use, with the threshold set for the target precision.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupShuffleSplit

from .load import FLAG_PREFIX, flag_columns

MODELS = {
    "agent": {"pos": ("C3", "C4", "C5"), "sides": ("agent", "both"), "verdict_col": "suspected_agent"},
    "antidetect": {"pos": ("C6",), "sides": ("antidetect", "both"), "verdict_col": "anti_detect"},
}
NEG = ("C1", "C2")


@dataclass
class FitResult:
    model: str
    ok: bool
    message: str = ""
    split: str = ""
    n_train: int = 0
    n_test: int = 0
    weights: dict[str, int] = field(default_factory=dict)
    negative: dict[str, float] = field(default_factory=dict)  # coefficients < 0, clamped to weight 0
    threshold: int | None = None
    coefficients: dict[str, float] = field(default_factory=dict)
    intercept: float = float("nan")
    auc_test: float = float("nan")
    test: dict[str, float] = field(default_factory=dict)       # integer scorer on held-out runs
    current: dict[str, float] = field(default_factory=dict)    # Node's stored verdicts, same rows


def split_by_run_date(df: pd.DataFrame, train_share: float = 0.7, seed: int = 7) -> tuple[pd.Index, pd.Index, str]:
    dates = sorted(d for d in df["run_date"].dropna().unique())
    if len(dates) >= 2:
        cut = min(max(1, math.ceil(len(dates) * train_share)), len(dates) - 1)
        train_dates = set(dates[:cut])
        tr = df.index[df["run_date"].isin(train_dates)]
        te = df.index[~df["run_date"].isin(train_dates)]
        return tr, te, f"by run date: {dates[0]}..{dates[cut - 1]} fit, {dates[cut]}..{dates[-1]} test"
    # Single run date: fall back to whole links (runs) at random, never splitting a link.
    gss = GroupShuffleSplit(n_splits=1, train_size=train_share, random_state=seed)
    tr_i, te_i = next(gss.split(df, groups=df["link_id"]))
    return df.index[tr_i], df.index[te_i], "by link (only one run date; fall back to random runs)"


def _metrics(y: np.ndarray, pred: np.ndarray, cohorts: pd.Series) -> dict[str, float]:
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    def fpr(c):
        m = (cohorts == c).to_numpy()
        return float(pred[m].mean()) if m.any() else float("nan")
    return {
        "precision": tp / (tp + fp) if tp + fp else float("nan"),
        "recall": tp / (tp + fn) if tp + fn else float("nan"),
        "fpr_c1": fpr("C1"), "fpr_c2": fpr("C2"),
        "tp": tp, "fp": fp, "fn": fn,
    }


def _integer_scheme(coef: np.ndarray, max_weight: int = 5) -> np.ndarray:
    m = np.abs(coef).max()
    if not np.isfinite(m) or m == 0:
        return np.zeros_like(coef, dtype=int)
    return np.round(coef / (m / max_weight)).astype(int)


def _pick_threshold(scores: np.ndarray, y: np.ndarray, precision_target: float) -> int:
    """Lowest integer threshold whose precision on the fitting runs meets the target
    (lowest = most recall). If none does, the threshold with the best precision."""
    best, best_prec = None, -1.0
    for t in range(int(scores.min()), int(scores.max()) + 2):
        pred = scores >= t
        if not pred.any():
            continue
        prec = (pred & (y == 1)).sum() / pred.sum()
        if prec >= precision_target:
            return t
        if prec > best_prec:
            best, best_prec = t, prec
    return best if best is not None else int(scores.max()) + 1


def fit_model(df: pd.DataFrame, model: str, precision_target: float = 0.98, C: float = 1.0,
              allow_negative: bool = False) -> FitResult:
    """allow_negative=False (default) clamps negative weights to 0. A negative weight
    would let a visitor lower its own score by triggering that signal on purpose
    (for example, using a datacenter IP to look less like an anti-detect browser)."""
    spec = MODELS[model]
    data = df[df["cohort"].isin(spec["pos"] + NEG)].copy()
    feats = flag_columns(df, spec["sides"])
    res = FitResult(model=model, ok=False)
    if not feats:
        res.message = "no flags of this side in the data"
        return res
    y_all = data["cohort"].isin(spec["pos"]).astype(int).to_numpy()
    if y_all.sum() == 0 or (1 - y_all).sum() == 0:
        res.message = f"need both target ({'+'.join(spec['pos'])}) and C1/C2 visits"
        return res

    tr, te, how = split_by_run_date(data)
    res.split = how
    Xtr = data.loc[tr, feats].astype(float).to_numpy(); ytr = data.loc[tr, "cohort"].isin(spec["pos"]).astype(int).to_numpy()
    Xte = data.loc[te, feats].astype(float).to_numpy(); yte = data.loc[te, "cohort"].isin(spec["pos"]).astype(int).to_numpy()
    res.n_train, res.n_test = len(tr), len(te)
    if len(set(ytr)) < 2:
        res.message = "fitting runs contain only one class; add more labeled runs"
        return res

    lr = LogisticRegression(C=C, class_weight="balanced", max_iter=2000)
    lr.fit(Xtr, ytr)
    coef = lr.coef_[0]
    res.coefficients = {f[len(FLAG_PREFIX):]: float(c) for f, c in zip(feats, coef)}
    res.intercept = float(lr.intercept_[0])

    res.negative = {f[len(FLAG_PREFIX):]: float(c) for f, c in zip(feats, coef) if c < 0}
    w = _integer_scheme(coef if allow_negative else np.clip(coef, 0, None))
    res.weights = {f[len(FLAG_PREFIX):]: int(v) for f, v in zip(feats, w) if v != 0}
    res.threshold = _pick_threshold(Xtr @ w, ytr, precision_target)

    if len(te):
        pred = (Xte @ w >= res.threshold).astype(int)
        res.test = _metrics(yte, pred, data.loc[te, "cohort"])
        if len(set(yte)) == 2:
            res.auc_test = float(roc_auc_score(yte, lr.predict_proba(Xte)[:, 1]))
        res.current = _metrics(yte, data.loc[te, spec["verdict_col"]].astype(int).to_numpy(), data.loc[te, "cohort"])
    res.ok = True
    return res


def fit_all(df: pd.DataFrame, precision_target: float = 0.98, allow_negative: bool = False) -> dict[str, FitResult]:
    return {m: fit_model(df, m, precision_target, allow_negative=allow_negative) for m in MODELS}


def confusion(df: pd.DataFrame) -> pd.DataFrame:
    """Cohort x stored verdict counts, from the Node scorer's current output."""
    if df.empty:
        return pd.DataFrame()
    v = np.select(
        [df["verified_agent"].notna() & (df["verified_agent"] != ""),
         df["suspected_agent"] & df["anti_detect"], df["suspected_agent"], df["anti_detect"]],
        ["verified agent", "agent + anti-detect", "suspected agent", "anti-detect"], default="no evidence")
    return pd.crosstab(df["cohort"], pd.Series(v, index=df.index, name="verdict"))
