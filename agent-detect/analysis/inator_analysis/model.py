"""The "System 1" model: a fast, calibrated classifier that turns one visit's
evidence into percentages for human / agent / anti-detect.

Why this instead of a hosted decision model: the inputs are flags and numbers
your own pipeline already computed, the labels come from your own cohort runs,
and the result must run inside the capture app on every visit without sending
visitor fingerprints to a third party. A multinomial logistic regression with
temperature scaling does that in microseconds, and its per-flag contributions
explain each percentage.

Two models are fitted and compared on held-out runs:
  logistic   exportable to model.json for live scoring in Node
  boosted    gradient-boosted trees, calibrated; Python batch tagging only
Percentages are calibrated to the cohort mix you tested with. For live traffic,
set the expected real-world mix (MODEL_PRIORS in Node, --priors here) and the
logits are shifted accordingly.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.model_selection import GroupKFold, cross_val_predict

from .fit import split_by_run_date
from .load import FLAG_PREFIX

CLASSES = ["human", "agent", "antidetect"]
COHORT_CLASS = {"C1": "human", "C2": "human", "C3": "agent", "C4": "agent", "C5": "agent", "C6": "antidetect"}
UNCERTAIN_BELOW = 0.6

# Numeric features. Node rebuilds exactly these from the live verdict
# (server/model.js); keep the two lists identical.
NUMERIC = [
    # name, dataframe column, transform, cap
    ("js_ran", "js_ran", "bool", None),
    ("clicked", "clicked", "bool", None),
    ("hosting", "hosting", "bool", None),
    ("log_gap_ms", "gap_ms", "log1p", 2000.0),
    ("log_tcp_rtt_ms", "tcp_rtt_ms", "log1p", 2000.0),
    ("syn_hops", "syn_hops", "clip", 40.0),
    ("log_moves", "moves", "log1p", 5000.0),
    ("click_offset_px", "click_offset_px", "clip", 50.0),
    # CreepJS-based probes (client/probes.js); 0 when the probes did not run
    ("probes_ran", "probes_ran", "bool", None),
    ("log_creep_lies", "creep_lies", "log1p", 500.0),
    ("creep_headless_pct", "creep_headless_pct", "clip", 100.0),
    ("creep_stealth_pct", "creep_stealth_pct", "clip", 100.0),
]
MISSING_FOR = {"log_gap_ms", "log_tcp_rtt_ms", "syn_hops", "click_offset_px"}  # get an is-missing indicator


def reason_label(f: dict, x: float, z: float) -> str:
    name = f["name"].replace(FLAG_PREFIX, "")
    if f["kind"] in ("flag", "missing") or f.get("transform") == "bool":
        return name if x > 0 else f"no {name}"
    return f"{'high' if z > 0 else 'low'} {name}"


def labels(df: pd.DataFrame) -> pd.Series:
    return df["cohort"].map(COHORT_CLASS)


def feature_spec(df: pd.DataFrame) -> list[dict]:
    spec = [{"name": FLAG_PREFIX + f, "kind": "flag", "id": f} for f in df.attrs.get("flag_sides", {})]
    for name, col, transform, cap in NUMERIC:
        spec.append({"name": name, "kind": "num", "column": col, "transform": transform, "cap": cap})
        if name in MISSING_FOR:
            spec.append({"name": name + "_missing", "kind": "missing", "of": name})
    return spec


def build_matrix(df: pd.DataFrame, spec: list[dict]) -> np.ndarray:
    cols = []
    raw_num = {}
    for f in spec:
        if f["kind"] == "flag":
            cols.append(np.array(df[f["name"]], dtype=float) if f["name"] in df else np.zeros(len(df)))
        elif f["kind"] == "num":
            v = pd.to_numeric(df[f["column"]], errors="coerce") if f["column"] in df else pd.Series(np.nan, index=df.index)
            if f["transform"] == "bool":
                x = np.array(v.fillna(0).astype(float).clip(0, 1), dtype=float)
            else:
                missing = v.isna().to_numpy()
                vv = np.array(v.fillna(0).astype(float).clip(lower=0, upper=f["cap"]), dtype=float)  # writable copy
                x = np.log1p(vv) if f["transform"] == "log1p" else vv
                x[missing] = 0.0
            raw_num[f["name"]] = v.isna().to_numpy()
            cols.append(x)
        else:  # missing indicator
            cols.append(raw_num[f["of"]].astype(float))
    return np.column_stack(cols) if cols else np.zeros((len(df), 0))


def _standardize(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean = X.mean(axis=0)
    scale = X.std(axis=0)
    scale[scale == 0] = 1.0
    return mean, scale


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def _fit_temperature(logits: np.ndarray, y: np.ndarray) -> float:
    """One scalar T that minimizes log loss of softmax(logits / T)."""
    def nll(t):
        p = _softmax(logits / t)
        return -np.mean(np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1)))
    return float(minimize_scalar(nll, bounds=(0.05, 20.0), method="bounded").x)


def calibration_table(p: np.ndarray, y: np.ndarray, bins: int = 10) -> pd.DataFrame:
    """Reliability: among visits given ~X% for their top class, how often was it right?"""
    conf = p.max(axis=1); pred = p.argmax(axis=1); hit = (pred == y)
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi) if lo > 0 else (conf >= lo) & (conf <= hi)
        if m.any():
            rows.append({"stated": f"{lo:.0%}-{hi:.0%}", "visits": int(m.sum()),
                         "mean_stated": float(conf[m].mean()), "actually_right": float(hit[m].mean())})
    return pd.DataFrame(rows)


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    t = calibration_table(p, y, bins)
    if t.empty:
        return float("nan")
    return float((t["visits"] * (t["mean_stated"] - t["actually_right"]).abs()).sum() / t["visits"].sum())


def _metrics(p: np.ndarray, y: np.ndarray) -> dict:
    onehot = np.eye(len(CLASSES))[y]
    pred = p.argmax(axis=1)
    out = {"log_loss": float(log_loss(y, p, labels=list(range(len(CLASSES))))),
           "brier": float(np.mean(np.sum((p - onehot) ** 2, axis=1))),
           "accuracy": float((pred == y).mean()), "ece": ece(p, y)}
    for k, c in enumerate(CLASSES):
        tp = int(((pred == k) & (y == k)).sum()); fp = int(((pred == k) & (y != k)).sum())
        fn = int(((pred != k) & (y == k)).sum())
        out[f"precision_{c}"] = tp / (tp + fp) if tp + fp else float("nan")
        out[f"recall_{c}"] = tp / (tp + fn) if tp + fn else float("nan")
    return out


@dataclass
class LogisticModel:
    spec: list[dict]
    mean: np.ndarray
    scale: np.ndarray
    coef: np.ndarray          # (classes, features), on standardized features
    intercept: np.ndarray     # (classes,)
    temperature: float
    train_priors: dict
    meta: dict = field(default_factory=dict)

    def logits(self, X: np.ndarray) -> np.ndarray:
        return ((X - self.mean) / self.scale) @ self.coef.T + self.intercept

    def predict_proba(self, X: np.ndarray, priors: dict | None = None) -> np.ndarray:
        z = self.logits(X) / self.temperature
        if priors:
            shift = np.array([np.log(priors[c] / self.train_priors[c]) for c in CLASSES])
            z = z + shift
        return _softmax(z)

    def reasons(self, X: np.ndarray, k: int = 3) -> list[list[str]]:
        """Top features pushing each visit toward its predicted class, worded by the
        visit's actual value: 'J1-webdriver' when present, 'no clicked' when absent,
        'high log_gap_ms' / 'low log_gap_ms' for numbers. server/model.js mirrors this."""
        Z = (X - self.mean) / self.scale
        p = self.predict_proba(X)
        out = []
        for i, c in enumerate(p.argmax(axis=1)):
            contrib = Z[i] * (self.coef[c] - self.coef.mean(axis=0))
            words = []
            for j in np.argsort(-contrib)[:k]:
                if contrib[j] <= 0.05:
                    break
                words.append(reason_label(self.spec[j], X[i, j], Z[i, j]))
            out.append(words)
        return out

    def to_json(self) -> dict:
        return {"format": "inator-logistic-v1", "classes": CLASSES, "features": self.spec,
                "mean": self.mean.tolist(), "scale": self.scale.tolist(),
                "coef": self.coef.tolist(), "intercept": self.intercept.tolist(),
                "temperature": self.temperature, "train_priors": self.train_priors,
                "uncertain_below": UNCERTAIN_BELOW, **self.meta}


def fit_logistic(df: pd.DataFrame, spec: list[dict], C: float = 1.0) -> LogisticModel:
    y = labels(df).map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    X = build_matrix(df, spec)
    mean, scale = _standardize(X)
    Z = (X - mean) / scale
    lr = LogisticRegression(C=C, max_iter=5000)
    # Temperature from out-of-fold logits, so it isn't fitted on the model's own training fit.
    groups = df["link_id"].to_numpy()
    n_splits = max(2, min(5, len(np.unique(groups)), np.bincount(y, minlength=len(CLASSES)).min()))
    oof = cross_val_predict(LogisticRegression(C=C, max_iter=5000), Z, y, cv=GroupKFold(n_splits=n_splits),
                            groups=groups, method="decision_function")
    temperature = _fit_temperature(oof, y)
    lr.fit(Z, y)
    coef = np.zeros((len(CLASSES), Z.shape[1])); icpt = np.zeros(len(CLASSES))
    for row, k in enumerate(lr.classes_):
        coef[k], icpt[k] = lr.coef_[row], lr.intercept_[row]
    priors = {c: float((y == k).mean()) for k, c in enumerate(CLASSES)}
    return LogisticModel(spec, mean, scale, coef, icpt, temperature, priors)


def fit_boosted(df: pd.DataFrame, spec: list[dict]):
    y = labels(df).map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    X = build_matrix(df, spec)
    base = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, max_leaf_nodes=15, l2_regularization=1.0,
                                          random_state=0)
    groups = df["link_id"].to_numpy()
    n_splits = max(2, min(5, len(np.unique(groups)), np.bincount(y, minlength=len(CLASSES)).min()))
    cv = list(GroupKFold(n_splits=n_splits).split(X, y, groups))
    model = CalibratedClassifierCV(base, method="isotonic" if len(y) >= 300 else "sigmoid", cv=cv)
    model.fit(X, y)
    return model


@dataclass
class ModelReport:
    ok: bool
    message: str = ""
    split: str = ""
    n_train: int = 0
    n_test: int = 0
    holdout: dict = field(default_factory=dict)          # model name -> metrics
    calibration: dict = field(default_factory=dict)      # model name -> DataFrame
    chosen_for_tagging: str = "logistic"
    exported: LogisticModel | None = None                # refit on all labeled data
    boosted_full: object | None = None


def train_and_evaluate(df: pd.DataFrame) -> ModelReport:
    lab = df[df["cohort"].isin(COHORT_CLASS)].copy()
    lab.attrs = df.attrs
    rep = ModelReport(ok=False)
    present = set(labels(lab))
    if present != set(CLASSES):
        rep.message = f"need labeled visits for all three classes; have {sorted(present) or 'none'}"
        return rep
    spec = feature_spec(df)
    tr, te, how = split_by_run_date(lab)
    rep.split, rep.n_train, rep.n_test = how, len(tr), len(te)
    train, test = lab.loc[tr], lab.loc[te]
    train.attrs = test.attrs = df.attrs
    if set(labels(train)) != set(CLASSES) or set(labels(test)) != set(CLASSES):
        rep.message = "each split needs all three classes; add more labeled runs across more dates"
        return rep
    y_te = labels(test).map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    X_te = build_matrix(test, spec)

    lm = fit_logistic(train, spec)
    p_l = lm.predict_proba(X_te)
    rep.holdout["logistic"] = _metrics(p_l, y_te)
    rep.calibration["logistic"] = calibration_table(p_l, y_te)

    bm = fit_boosted(train, spec)
    p_b = bm.predict_proba(X_te)
    rep.holdout["boosted"] = _metrics(p_b, y_te)
    rep.calibration["boosted"] = calibration_table(p_b, y_te)

    rep.chosen_for_tagging = "boosted" if rep.holdout["boosted"]["log_loss"] < rep.holdout["logistic"]["log_loss"] else "logistic"

    # Final models on every labeled visit; the held-out numbers above describe them.
    rep.exported = fit_logistic(lab, spec)
    rep.exported.meta = {"trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n_visits": len(lab),
                         "holdout": rep.holdout["logistic"], "split": how}
    rep.boosted_full = fit_boosted(lab, spec)
    rep.ok = True
    return rep


def tag_visits(df: pd.DataFrame, rep: ModelReport, priors: dict | None = None, use: str | None = None) -> pd.DataFrame:
    """Per-visit percentages, a tag and the top reasons. A verified Web Bot Auth
    signature always wins the tag, whatever the percentages say."""
    spec = rep.exported.spec
    X = build_matrix(df, spec)
    which = use or rep.chosen_for_tagging
    if which == "boosted":
        p = rep.boosted_full.predict_proba(X)
        if priors:
            tp = rep.exported.train_priors
            p = p * np.array([priors[c] / tp[c] for c in CLASSES]); p = p / p.sum(axis=1, keepdims=True)
    else:
        p = rep.exported.predict_proba(X, priors)
    reasons = rep.exported.reasons(X)
    out = pd.DataFrame({"visit_id": df["visit_id"].to_numpy(), "cohort": df["cohort"].to_numpy(), "tool": df["tool"].to_numpy()})
    for k, c in enumerate(CLASSES):
        out[f"p_{c}"] = p[:, k].round(4)
    top = p.argmax(axis=1); conf = p.max(axis=1)
    tag = np.where(conf < UNCERTAIN_BELOW, "uncertain", np.array(CLASSES)[top])
    verified = df["verified_agent"].fillna("").astype(str).to_numpy()
    out["tag"] = np.where(verified != "", "agent (verified: " + verified + ")", tag)
    out["model"] = which
    out["reasons"] = [", ".join(r) for r in reasons]
    return out


def save_model(rep: ModelReport, path: str | Path) -> Path:
    p = Path(path)
    p.write_text(json.dumps(rep.exported.to_json(), indent=1, default=float))
    return p


def parity_cases(df: pd.DataFrame, model: LogisticModel, n: int = 25, seed: int = 0) -> list[dict]:
    """Visits in Node's shape plus the probabilities Python computes, so the Node
    side can prove it reproduces the model exactly (test/model.test.js)."""
    sub = df.sample(min(n, len(df)), random_state=seed)
    X = build_matrix(sub, model.spec)
    P = model.predict_proba(X)
    cases = []
    for (_, r), p in zip(sub.iterrows(), P):
        num = lambda v: None if pd.isna(v) else float(v)  # noqa: E731
        flags = [f["id"] for f in model.spec if f["kind"] == "flag" and bool(r.get(f["name"], False))]
        cases.append({
            "visit": {
                "flags": flags,
                "server": {"tcpRttUs": None if pd.isna(r["tcp_rtt_ms"]) else float(r["tcp_rtt_ms"]) * 1000,
                           "synHops": num(r["syn_hops"]), "geo": {"hosting": bool(r["hosting"]) if r["hosting"] is not None and not pd.isna(r["hosting"]) else None}},
                "client": ({"flags": [], "behaviour": {"moves": num(r["moves"]),
                                                       "click": ({"offsetPx": num(r["click_offset_px"])} if r["clicked"] else None)},
                            "raw": ({"creep": {"lies": {"total": num(r.get("creep_lies"))},
                                               "headless": {"headless": num(r.get("creep_headless_pct")),
                                                            "stealth": num(r.get("creep_stealth_pct"))}}}
                                    if r.get("probes_ran") else {})}
                           if r["js_ran"] else None),
                "hop": {"gapMs": num(r["gap_ms"])},
            },
            "expected": {c: float(p[k]) for k, c in enumerate(CLASSES)},
        })
    return cases
