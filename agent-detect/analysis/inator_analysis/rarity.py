"""Rarity and impossible combinations: how unusual is each visit compared with
the real people in C1 and C2?

Three measures, all computed against the reference cohorts (C1 people, C2
privacy browsers) with leave-one-out, so a reference visit is never compared
with itself:

entropy        per attribute, how much the value tells you about a visitor
               (bits; the AmIUnique / Panopticlick measure).
surprisal      per visit, the average number of bits its values cost under the
               reference distribution: -log2 P(value). Values no person showed
               cost the most. Noise-injecting anti-detect browsers produce
               canvas/audio/WebGL hashes nobody else has, so they score high.
impossible     pairs of coarse values that each appear among people but never
combinations   together, e.g. a macOS user agent with an NVIDIA GPU, or a
               Windows user agent with a TTL that starts at 64.

Limits, read before trusting a number:
- A small reference set makes every real person look rare. Collect a few hundred
  C1/C2 visits before reading surprisal as anything but a ranking.
- Surprisal adds bits across attributes as if they were independent. They are
  not (GPU and WebGL hash move together), so the totals overstate rarity. Use
  the mean and the percentile against people, not the raw total.
- "Impossible" means "not seen in your reference data". Real but uncommon
  setups (a Hackintosh, a Windows VM on a Mac) will appear here until the
  reference set includes them.
"""
from __future__ import annotations

import json
import math
import re

import numpy as np
import pandas as pd

from .load import HASH_PREFIX

REFERENCE = ("C1", "C2")

# Fine-grained attributes for entropy and surprisal. Identifiers built to be
# unique per device (creep_fp_id, fpjs_id, ja4h) are left out on purpose: they
# would make every visit look maximally rare.
BASE_ATTRS = ["ja4", "ja4t", "syn_ttl", "webgl_renderer", "canvas_hash", "fonts", "tz", "hardware_concurrency",
              "screen", "accept_language", "user_agent", "creep_gpu", "worker_type", "creep_privacy"]

# Pairs of coarse values that should agree on a real device.
PAIRS = [
    ("ua_os", "gpu_family"), ("ua_os", "ttl_initial"), ("ua_os", "font_os"), ("ua_os", "ch_platform"),
    ("ua_os", "ja4t"), ("ua_os", "worker_platform"), ("ua_os", "hardware_concurrency"),
    ("gpu_family", "hardware_concurrency"), ("ua_browser", "ja4"),
    ("tz", "country"), ("lang_region", "country"),
]


def ua_os(ua) -> str | None:
    if not isinstance(ua, str) or not ua:
        return None
    for pat, name in ((r"Windows NT", "Windows"), (r"Android", "Android"), (r"iPhone|iPad|iPod", "iOS"),
                      (r"Mac OS X|Macintosh", "macOS"), (r"CrOS", "Chrome OS"), (r"Linux", "Linux")):
        if re.search(pat, ua):
            return name
    return "unknown"


def ua_browser(ua) -> str | None:
    if not isinstance(ua, str) or not ua:
        return None
    for pat, name in ((r"Edg/(\d+)", "Edge"), (r"Firefox/(\d+)", "Firefox"), (r"(?:Chrome|Chromium)/(\d+)", "Chrome"),
                      (r"Version/(\d+).*Safari", "Safari")):
        m = re.search(pat, ua)
        if m:
            return f"{name} {m.group(1)}"
    return "other"


def gpu_family(renderer) -> str | None:
    if not isinstance(renderer, str) or not renderer:
        return None
    r = renderer.lower()
    for key, name in (("swiftshader", "SwiftShader"), ("llvmpipe", "llvmpipe"), ("apple", "Apple"), ("nvidia", "NVIDIA"),
                      ("geforce", "NVIDIA"), ("radeon", "AMD"), ("amd", "AMD"), ("intel", "Intel"), ("adreno", "Adreno"),
                      ("mali", "Mali"), ("powervr", "PowerVR"), ("microsoft basic", "Microsoft Basic")):
        if key in r:
            return name
    return "other"


def font_os(fonts) -> str | None:
    if not isinstance(fonts, str) or not fonts:
        return None
    try:
        found = json.loads(fonts)
    except ValueError:
        return None
    present = sorted(k for k, v in (found or {}).items() if v)
    return "+".join(present) if present else "none"


def ttl_initial(ttl) -> float | None:
    if ttl is None or pd.isna(ttl):
        return None
    return 64 if ttl <= 64 else 128 if ttl <= 128 else 255


def coarse(df: pd.DataFrame) -> pd.DataFrame:
    """Coarse values used by the impossible-combination check."""
    get = lambda c: df[c] if c in df else pd.Series(None, index=df.index, dtype=object)  # noqa: E731
    out = pd.DataFrame(index=df.index)
    out["ua_os"] = get("user_agent").map(ua_os)
    out["ua_browser"] = get("user_agent").map(ua_browser)
    out["ch_platform"] = get("sec_ch_ua_platform").map(lambda s: s.strip('"') if isinstance(s, str) and s else None)
    out["gpu_family"] = get("webgl_renderer").map(gpu_family)
    out["ttl_initial"] = get("syn_ttl").map(ttl_initial)
    out["font_os"] = get("fonts").map(font_os)
    out["lang_region"] = get("accept_language").map(
        lambda s: (re.search(r"^[a-z]{2,3}-([A-Z]{2})", s) or [None, None])[1] if isinstance(s, str) else None)
    for c in ("ja4t", "ja4", "worker_platform", "hardware_concurrency", "screen", "tz", "country"):
        out[c] = get(c)
    return out


def _attrs(df: pd.DataFrame, attrs: list[str] | None) -> list[str]:
    if attrs is not None:
        return [a for a in attrs if a in df]
    return [a for a in BASE_ATTRS if a in df] + sorted(c for c in df.columns if c.startswith(HASH_PREFIX))


def _key(s: pd.Series) -> pd.Series:
    """Hashable string keys; NaN stays NaN."""
    return s.map(lambda v: None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v))


def attribute_entropy(df: pd.DataFrame, attrs: list[str] | None = None, reference=REFERENCE) -> pd.DataFrame:
    """Per attribute among reference visits: Shannon entropy in bits, the share of
    visitors whose value nobody else has, and how often the value is present."""
    ref = df[df["cohort"].isin(reference)]
    rows = []
    for a in _attrs(df, attrs):
        v = _key(ref[a]).dropna()
        n = len(v)
        if n == 0:
            continue
        p = v.value_counts(normalize=True).to_numpy()
        counts = v.map(v.value_counts())
        h = float(-(p * np.log2(p)).sum())
        rows.append({"attribute": a, "reference_visits": n, "distinct": int(v.nunique()), "entropy_bits": round(h, 3),
                     "normalized": round(h / math.log2(n), 3) if n > 1 else 0.0,
                     "unique_share": float((counts == 1).mean()),
                     "present_all": float(df[a].notna().mean())})
    return pd.DataFrame(rows).sort_values("entropy_bits", ascending=False).reset_index(drop=True) if rows else \
        pd.DataFrame(columns=["attribute", "reference_visits", "distinct", "entropy_bits", "normalized", "unique_share", "present_all"])


def surprisal(df: pd.DataFrame, attrs: list[str] | None = None, reference=REFERENCE, alpha: float = 0.5) -> pd.DataFrame:
    """Per visit: mean and total -log2 P(value) over the attributes it has, how many
    of its values no reference visitor showed, and its percentile among people."""
    attrs = _attrs(df, attrs)
    is_ref = df["cohort"].isin(reference).to_numpy()
    bits = np.zeros((len(df), len(attrs)))
    present = np.zeros_like(bits, dtype=bool)
    unseen = np.zeros_like(bits, dtype=bool)
    for j, a in enumerate(attrs):
        keys = _key(df[a])
        ref_keys = keys[is_ref].dropna()
        n, k = len(ref_keys), ref_keys.nunique()
        if n == 0:
            continue
        counts = ref_keys.value_counts()
        c = keys.map(counts).fillna(0).to_numpy(dtype=float)
        has = keys.notna().to_numpy()
        loo = is_ref & has                       # leave the visit itself out
        c_loo = c - loo
        n_loo = n - loo
        p = (c_loo + alpha) / (n_loo + alpha * (k + 1))
        bits[:, j] = np.where(has, -np.log2(p), 0.0)
        present[:, j] = has
        unseen[:, j] = has & (c_loo == 0)
    n_attr = present.sum(axis=1)
    total = bits.sum(axis=1)
    mean = np.divide(total, n_attr, out=np.full(len(df), np.nan), where=n_attr > 0)
    ref_mean = np.sort(mean[is_ref & ~np.isnan(mean)])
    pct = (np.searchsorted(ref_mean, mean, side="right") / len(ref_mean)) if len(ref_mean) else np.full(len(df), np.nan)
    pct = np.where(np.isnan(mean), np.nan, pct)
    worst = [", ".join(attrs[j] for j in np.argsort(-bits[i])[:3] if unseen[i, j]) or None for i in range(len(df))]
    return pd.DataFrame({
        "visit_id": df["visit_id"].to_numpy(), "cohort": df["cohort"].to_numpy(), "tool": df["tool"].to_numpy(),
        "attrs_scored": n_attr, "surprisal_bits_mean": np.round(mean, 3), "surprisal_bits_total": np.round(total, 1),
        "unseen_values": unseen.sum(axis=1), "unseen_attrs": worst,
        "surprisal_pct_vs_people": np.round(pct, 3),
    })


def impossible_combinations(df: pd.DataFrame, pairs=PAIRS, reference=REFERENCE, min_support: int = 3) -> pd.DataFrame:
    """Per visit: pairs whose two values each appear among at least `min_support`
    reference visits, but never together (leave-one-out)."""
    c = coarse(df)
    is_ref = df["cohort"].isin(reference).to_numpy()
    hits = [[] for _ in range(len(df))]
    for a, b in pairs:
        ka, kb = _key(c[a]), _key(c[b])
        both = ka.notna() & kb.notna()
        ra, rb = ka[is_ref & both.to_numpy()], kb[is_ref & both.to_numpy()]
        if ra.empty:
            continue
        sa, sb = ra.value_counts(), rb.value_counts()
        pair_counts = pd.Series(list(zip(ra, rb))).value_counts()
        for i in np.flatnonzero(both.to_numpy()):
            va, vb = ka.iat[i], kb.iat[i]
            own = 1 if is_ref[i] else 0
            if sa.get(va, 0) - own >= min_support and sb.get(vb, 0) - own >= min_support \
                    and pair_counts.get((va, vb), 0) - own == 0:
                hits[i].append(f"{a}={va} & {b}={vb}")
    return pd.DataFrame({"visit_id": df["visit_id"].to_numpy(), "cohort": df["cohort"].to_numpy(),
                         "tool": df["tool"].to_numpy(), "impossible_pairs": [len(h) for h in hits],
                         "impossible_detail": ["; ".join(h) or None for h in hits]})


def impossible_rates(imp: pd.DataFrame) -> pd.DataFrame:
    """Share of each cohort's visits with each impossible pair type."""
    rows = []
    for _, r in imp.iterrows():
        detail = r["impossible_detail"] if isinstance(r["impossible_detail"], str) else ""
        for item in detail.split("; "):
            if item:
                rows.append({"visit_id": r["visit_id"], "cohort": r["cohort"],
                             "pair": " & ".join(p.split("=")[0] for p in item.split(" & "))})
    if not rows:
        return pd.DataFrame()
    t = pd.DataFrame(rows).drop_duplicates().groupby(["pair", "cohort"]).size().unstack(fill_value=0)
    sizes = imp.groupby("cohort").size()
    return (t / sizes.reindex(t.columns)).round(3)


def by_cohort(sur: pd.DataFrame, imp: pd.DataFrame) -> pd.DataFrame:
    m = sur.merge(imp[["visit_id", "impossible_pairs"]], on="visit_id")
    g = m.groupby("cohort")
    return pd.DataFrame({
        "visits": g.size(),
        "median_bits": g["surprisal_bits_mean"].median().round(2),
        "p90_bits": g["surprisal_bits_mean"].quantile(0.9).round(2),
        "median_pct_vs_people": g["surprisal_pct_vs_people"].median().round(2),
        "any_unseen_value": g["unseen_values"].apply(lambda s: (s > 0).mean()).round(3),
        "any_impossible_pair": g["impossible_pairs"].apply(lambda s: (s > 0).mean()).round(3),
    }).reset_index()
