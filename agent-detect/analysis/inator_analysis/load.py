"""Load the capture app's visit store into one flat DataFrame.

One row per visit. Nested JSON from the Node app (server, client, rtt, verdict)
is flattened into named columns, and every flag ID becomes a boolean column
named "flag:<id>". The flag's side (agent / antidetect / both) is kept in
df.attrs["flag_sides"].
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

FLAG_PREFIX = "flag:"
HASH_PREFIX = "h:"   # one column per CreepJS component hash, e.g. "h:canvas2d"
HASH_COMPONENTS = ("canvas2d", "canvasWebgl", "canvasWebglParameters", "offlineAudioContext", "fonts", "voices",
                   "maths", "consoleErrors", "css", "styleSystem", "cssMedia", "screen", "svg", "domRect", "intl",
                   "media", "mimeTypes", "windowFeatures", "htmlElementVersion", "navigator", "workerScope",
                   "timezone", "features", "headless", "resistance", "deviceOfTimezone")
COHORTS = ("C1", "C2", "C3", "C4", "C5", "C6")

_QUERY = """
SELECT v.id, v.link_id, v.t0, v.t1, v.t3, v.t5, v.ip, v.server, v.client, v.rtt, v.verdict,
       l.url, l.cohort, l.tool, l.created_at
FROM visits v JOIN links l ON l.id = v.link_id
"""


def _j(value: Any) -> dict:
    if value is None or value == "":
        return {}
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {}


def _num(value: Any) -> float:
    try:
        return float(value) if value is not None else np.nan
    except (TypeError, ValueError):
        return np.nan


def cohort_code(label: Any) -> str:
    """'C3', 'c3', 'C3 cloud agents' -> 'C3'. Anything else -> 'unlabeled'."""
    if not isinstance(label, str) or not label.strip():
        return "unlabeled"
    head = label.strip().split()[0].upper()
    return head if head in COHORTS else "unlabeled"


def _row(r: dict) -> dict:
    s, c, rt, v = _j(r.get("server")), _j(r.get("client")), _j(r.get("rtt")), _j(r.get("verdict"))
    raw, beh = c.get("raw") or {}, c.get("behaviour") or {}
    click = beh.get("click") or {}
    geo, sig, bot = s.get("geo") or {}, s.get("signature") or {}, s.get("declaredBot") or {}
    hop, fwd = v.get("hop") or {}, c.get("forward") or {}
    webgl, scr = raw.get("webgl") or {}, raw.get("screen") or {}
    creep = raw.get("creep") or {}
    probes_ok = bool(creep) and not creep.get("error")
    cl, ch, cw = creep.get("lies") or {}, creep.get("headless") or {}, creep.get("worker") or {}
    cn, cg, cr = creep.get("navigator") or {}, creep.get("gpu") or {}, creep.get("resistance") or {}
    fpjs = raw.get("fpjs") or {}
    t0 = r.get("t0")
    rel = lambda t: (t - t0) if (t is not None and t0 is not None) else np.nan  # noqa: E731
    samples = rt.get("samplesMs") or []
    created = r.get("created_at") or t0

    out = {
        "visit_id": r.get("id"), "link_id": r.get("link_id"), "url": r.get("url"),
        "cohort_label": r.get("cohort"), "cohort": cohort_code(r.get("cohort")), "tool": r.get("tool") or "",
        "t0": pd.to_datetime(t0, unit="ms", utc=True) if t0 else pd.NaT,
        "run_date": pd.to_datetime(created, unit="ms", utc=True).date() if created else None,
        "t1_ms": rel(r.get("t1")), "t3_ms": rel(r.get("t3")), "t5_ms": rel(r.get("t5")),
        "t4_client_ms": _num(fwd.get("t4ClientMs")),
        "forward_auto": bool(fwd.get("auto")), "forward_nojs": bool(fwd.get("nojs")),
        # server / network
        "ip": s.get("ip") or r.get("ip"), "user_agent": s.get("userAgent"),
        "sec_ch_ua_platform": s.get("secChUaPlatform"), "accept_language": s.get("acceptLanguage"),
        "ja4": s.get("ja4"), "ja4h": s.get("ja4h"), "ja4t": s.get("ja4t"),
        "syn_ttl": _num(s.get("synTtl")), "syn_hops": _num(s.get("synHops")),
        "tcp_rtt_ms": _num(s.get("tcpRttUs")) / 1000,
        "signature_type": sig.get("type"), "signature_agent": sig.get("agent"),
        "declared_bot": bot.get("token"), "declared_bot_status": bot.get("status"),
        "country": geo.get("country"), "city": geo.get("city"), "asn": _num(geo.get("asn")),
        "as_org": geo.get("asOrg"), "hosting": geo.get("hosting"), "city_source": geo.get("citySource"),
        "ip_private": bool(geo.get("private")),
        # timing
        "rtt_samples": len(samples), "page_rtt_min_ms": min(samples) if samples else np.nan,
        "tcp_rtt_ws_ms": _num(rt.get("tcpRttUsWs")) / 1000,
        "gap_ms": _num(hop.get("gapMs")), "geo_floor_ms": _num(hop.get("geoFloorMs")),
        # page
        "js_ran": isinstance(c.get("flags"), list),
        "webgl_renderer": webgl.get("renderer"), "webgl_vendor": webgl.get("vendor"),
        "canvas_hash": raw.get("canvasHash"), "audio": _num(raw.get("audio")),
        "fonts": json.dumps(raw.get("fonts"), sort_keys=True) if raw.get("fonts") is not None else None,
        "non_native": ";".join(raw.get("nonNative") or []) or None,
        "tz": raw.get("tz"), "tz_offset": _num(raw.get("tzOffset")),
        "hardware_concurrency": _num(raw.get("hardwareConcurrency")),
        "screen": f'{scr.get("w")}x{scr.get("h")}' if scr else None,
        "webrtc_srflx": ",".join(raw.get("webrtcSrflx") or []) or None,
        # CreepJS-based probes and FingerprintJS
        "probes_ran": probes_ok,
        "creep_lies": _num(cl.get("total")) if probes_ok else np.nan,
        "creep_lie_apis": ",".join(cl.get("apis") or []) or None,
        "creep_headless_pct": _num(ch.get("headless")) if probes_ok else np.nan,
        "creep_like_headless_pct": _num(ch.get("likeHeadless")) if probes_ok else np.nan,
        "creep_stealth_pct": _num(ch.get("stealth")) if probes_ok else np.nan,
        "creep_fp_id": creep.get("fpId"), "creep_fuzzy": creep.get("fuzzy"),
        "creep_bot_hash": (creep.get("bot") or {}).get("hash"),
        "worker_type": cw.get("type"), "worker_platform": cw.get("platform"),
        "worker_hc": _num(cw.get("hardwareConcurrency")),
        "creep_gpu": cg.get("renderer"), "creep_gpu_confidence": cg.get("confidence"),
        "creep_privacy": cr.get("privacy"), "creep_extension": cr.get("extension"),
        "creep_platform_version": (cn.get("uaData") or {}).get("platformVersion"),
        "creep_device": cn.get("device"),
        "fpjs_id": fpjs.get("visitorId"),
        "fpjs_stable": (fpjs.get("visitorId") == fpjs.get("second")) if fpjs.get("visitorId") else None,
        **{HASH_PREFIX + k: v for k, v in (creep.get("hashes") or {}).items() if k in HASH_COMPONENTS},
        # behaviour
        "moves": _num(beh.get("moves")), "path_px": _num(beh.get("pathPx")),
        "straightness": _num(beh.get("straightness")), "pointer_type": beh.get("pointerType"),
        "click_offset_px": _num(click.get("offsetPx")), "click_trusted": click.get("trusted"),
        "clicked": bool(click),
        # verdict as stored by the Node scorer
        "verified_agent": v.get("verifiedAgent"), "suspected_agent": bool(v.get("suspectedAgent")),
        "anti_detect": bool(v.get("antiDetect")),
        "agent_score": _num(v.get("agentScore")), "antidetect_score": _num(v.get("antiDetectScore")),
    }
    out["_flags"] = v.get("flags") or []
    return out


def flatten(rows: Iterable[dict]) -> pd.DataFrame:
    recs = [_row(r) for r in rows]
    sides: dict[str, str] = {}
    for rec in recs:
        for f in rec["_flags"]:
            sides.setdefault(f.get("id"), f.get("side", "both"))
    ids = sorted(k for k in sides if k)
    for rec in recs:
        fired = {f.get("id") for f in rec.pop("_flags")}
        for fid in ids:
            rec[FLAG_PREFIX + fid] = fid in fired
    df = pd.DataFrame.from_records(recs)
    if df.empty:
        df = pd.DataFrame(columns=["visit_id", "cohort", "tool", "run_date"])
    df.attrs["flag_sides"] = {fid: sides[fid] for fid in ids}
    return df


def load_db(path: str | Path) -> pd.DataFrame:
    con = sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in con.execute(_QUERY)]
    finally:
        con.close()
    return flatten(rows)


def load_jsonl(path: str | Path) -> pd.DataFrame:
    """Reads visits.jsonl from scripts/export-visits.js (already joined with links)."""
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                r.setdefault("created_at", r.get("t0"))
                rows.append(r)
    return flatten(rows)


def load(path: str | Path) -> pd.DataFrame:
    p = Path(path)
    return load_jsonl(p) if p.suffix == ".jsonl" else load_db(p)


def flag_columns(df: pd.DataFrame, sides: Iterable[str] | None = None) -> list[str]:
    """Flag columns, optionally only those whose side is in `sides`."""
    fs = df.attrs.get("flag_sides", {})
    return [FLAG_PREFIX + f for f, s in fs.items() if sides is None or s in sides]
