"""Phase 6 population checks.

P1 device linkage   visits that claim different identities but share the values
                    a browser can't easily change (TCP stack, TTL, GPU, fonts,
                    network). Anti-detect tools rotate the claimed identity;
                    the machine underneath stays the same.
P2 velocity         visits per hour per JA4, per network (ASN), per linked device.
P3 tool traces      values or flag combinations that are common inside one
                    labeled tool and rare everywhere else.
"""
from __future__ import annotations

import hashlib

import pandas as pd

from .load import FLAG_PREFIX

# Values an anti-detect profile rarely changes (all must match to link visits).
STABLE = ["ja4t", "syn_ttl", "webgl_renderer", "fonts", "asn", "hardware_concurrency"]
# Values an anti-detect profile does change (more distinct values = more identities).
CLAIMED = ["user_agent", "canvas_hash", "ja4", "screen", "tz"]


def _key(row: pd.Series, cols: list[str]) -> str | None:
    vals = [row[c] for c in cols]
    if any(pd.isna(v) or v in ("", None) for v in vals):
        return None  # incomplete fingerprints are never linked
    return hashlib.sha1("|".join(map(str, vals)).encode()).hexdigest()[:12]


def device_linkage(df: pd.DataFrame, min_visits: int = 3, min_identities: int = 2,
                   window: str = "1D") -> pd.DataFrame:
    """Clusters of visits with identical stable values inside one time window,
    ranked by how many different identities they claimed.

    Caveat: two people with the same laptop model on the same ISP can collide.
    Treat a cluster as a lead to inspect, not a verdict."""
    if df.empty or any(c not in df for c in STABLE):
        return pd.DataFrame()
    d = df.copy()
    d["device_key"] = d.apply(lambda r: _key(r, STABLE), axis=1)
    d = d[d["device_key"].notna() & d["t0"].notna()]
    if d.empty:
        return pd.DataFrame()
    d["window"] = d["t0"].dt.floor(window)
    g = d.groupby(["device_key", "window"])
    out = g.agg(
        visits=("visit_id", "count"),
        identities=("user_agent", "nunique"),
        canvas_hashes=("canvas_hash", "nunique"),
        ja4s=("ja4", "nunique"),
        ips=("ip", "nunique"),
        cohorts=("cohort", lambda s: ",".join(sorted(set(s)))),
        tools=("tool", lambda s: ",".join(sorted(set(filter(None, s))))),
        renderer=("webgl_renderer", "first"),
        ja4t=("ja4t", "first"),
    ).reset_index()
    out["claimed_identities"] = out[["identities", "canvas_hashes", "ja4s"]].max(axis=1)
    out = out[(out["visits"] >= min_visits) & (out["claimed_identities"] >= min_identities)]
    return out.sort_values(["claimed_identities", "visits"], ascending=False).reset_index(drop=True)


def velocity(df: pd.DataFrame, by: str, top: int = 20, window: str = "1h") -> pd.DataFrame:
    """Busiest windows per value of `by` (e.g. 'ja4', 'asn'), with C1's typical rate for scale."""
    if df.empty or by not in df:
        return pd.DataFrame()
    d = df[df[by].notna() & df["t0"].notna()].copy()
    if d.empty:
        return pd.DataFrame()
    d["window"] = d["t0"].dt.floor(window)
    counts = d.groupby([by, "window"]).agg(visits=("visit_id", "count"),
                                           cohorts=("cohort", lambda s: ",".join(sorted(set(s))))).reset_index()
    c1 = counts[counts["cohorts"] == "C1"]["visits"]
    counts["c1_p99"] = float(c1.quantile(0.99)) if len(c1) else float("nan")
    return counts.sort_values("visits", ascending=False).head(top).reset_index(drop=True)


def tool_traces(df: pd.DataFrame, min_in: float = 0.8, max_out: float = 0.01, min_visits: int = 5,
                cohorts: tuple[str, ...] = ("C3", "C4", "C6")) -> pd.DataFrame:
    """For each labeled tool, values (and fired-flag combinations) seen in at least
    `min_in` of its visits and at most `max_out` of all other visits."""
    if df.empty:
        return pd.DataFrame()
    flag_cols = [c for c in df.columns if c.startswith(FLAG_PREFIX)]
    d = df.copy()
    d["flag_combo"] = d[flag_cols].apply(lambda r: "+".join(c[len(FLAG_PREFIX):] for c, v in r.items() if v), axis=1) \
        if flag_cols else ""
    fields = ["ja4", "ja4h", "ja4t", "canvas_hash", "webgl_renderer", "non_native", "fonts", "flag_combo",
              "creep_bot_hash", "creep_lie_apis", "worker_type", "creep_extension", "creep_gpu"]
    rows = []
    for tool, sub in d[d["cohort"].isin(cohorts)].groupby("tool"):
        if not tool or len(sub) < min_visits:
            continue
        rest = d[d["tool"] != tool]
        for f in fields:
            if f not in d:
                continue
            for val, share_in in sub[f].value_counts(normalize=True, dropna=True).items():
                if share_in < min_in or val in ("", None):
                    continue
                share_out = float((rest[f] == val).mean()) if len(rest) else 0.0
                if share_out <= max_out:
                    rows.append({"tool": tool, "cohort": sub["cohort"].iloc[0], "field": f,
                                 "value": str(val)[:120], "share_in_tool": share_in,
                                 "share_elsewhere": share_out, "tool_visits": len(sub)})
    return pd.DataFrame(rows).sort_values(["tool", "share_in_tool"], ascending=[True, False]).reset_index(drop=True) \
        if rows else pd.DataFrame(columns=["tool", "cohort", "field", "value", "share_in_tool", "share_elsewhere", "tool_visits"])


def id_linkage(df: pd.DataFrame, min_visits: int = 3) -> pd.DataFrame:
    """P1 by device ID: visits sharing a CreepJS stable ID or a FingerprintJS
    visitor ID while claiming several user agents or arriving from several IPs.

    CreepJS leaves out of its stable ID every component it caught lying, so a
    profile that rotates its user agent and canvas often keeps the same ID; that
    is the point of running it. Same caveat as device_linkage: identical
    laptops on identical software can share an ID."""
    rows = []
    for col, label in (("creep_fp_id", "creep"), ("fpjs_id", "fpjs")):
        if col not in df:
            continue
        d = df[df[col].notna()]
        if d.empty:
            continue
        g = d.groupby(col).agg(visits=("visit_id", "count"), user_agents=("user_agent", "nunique"),
                               ips=("ip", "nunique"), ja4s=("ja4", "nunique"),
                               cohorts=("cohort", lambda s: ",".join(sorted(set(s)))),
                               tools=("tool", lambda s: ",".join(sorted(set(filter(None, s)))))).reset_index()
        g = g[(g["visits"] >= min_visits) & ((g["user_agents"] >= 2) | (g["ips"] >= 2))]
        g.insert(0, "id_type", label)
        g = g.rename(columns={col: "id"})
        g["id"] = g["id"].str[:16]
        rows.append(g)
    if not rows:
        return pd.DataFrame(columns=["id_type", "id", "visits", "user_agents", "ips", "ja4s", "cohorts", "tools"])
    return pd.concat(rows).sort_values(["user_agents", "visits"], ascending=False).reset_index(drop=True)
