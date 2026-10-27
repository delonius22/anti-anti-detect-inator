"""Synthetic visits in the capture app's exact SQLite format, for trying the
toolkit before real cohort runs exist. The rates are invented: plausible
enough to exercise every report section, not a prediction of real results."""
from __future__ import annotations

import json
import random
import sqlite3
import string
from datetime import datetime, timedelta, timezone
from pathlib import Path

FLAGS = {  # id: (side, weight) exactly as the Node scorer emits them
    "J1-webdriver": ("agent", 5), "J2-cdp-runtime": ("agent", 2), "J3-zero-outer-window": ("agent", 2),
    "J3-headless-ua": ("agent", 5), "J4-software-gpu": ("agent", 2), "B1-no-pointer-path": ("agent", 3),
    "B1-pointer-jump": ("agent", 2), "B2-dead-centre-click": ("agent", 3), "B3-untrusted-events": ("agent", 4),
    "N8-no-javascript": ("agent", 2), "N2-declared-bot-verified": ("agent", 5),
    "X1-ua-vs-client-hints": ("both", 4), "X3-ttl-vs-ua-os": ("both", 3), "J10-fonts-vs-ua-os": ("both", 3),
    "J10-linux-fonts": ("both", 2), "H4-rtt-gap": ("both", 3), "N3-datacenter-asn": ("both", 2),
    "X4-language-vs-ip-country": ("both", 1), "J12-timezone-vs-ip": ("both", 2), "H5-faster-than-light": ("both", 3),
    "J5-patched-apis": ("antidetect", 4), "J6-canvas-noise": ("antidetect", 4), "J7-gpu-vs-ua-os": ("antidetect", 3),
    "J7-audio-noise": ("antidetect", 3), "J8-worker-vs-page": ("antidetect", 4),
    "J9-engine-older-than-claimed": ("antidetect", 4), "J11-webrtc-ip-mismatch": ("antidetect", 3),
    # CreepJS-based probes and FingerprintJS (client/stop.js, server/scoring.js)
    "C1-prototype-lies": ("antidetect", 3), "C1-many-lies": ("antidetect", 2), "C11-component-lied": ("antidetect", 3),
    "C2-headless-traits": ("agent", 4), "C2-like-headless": ("agent", 1), "C3-stealth-patches": ("both", 4),
    "C4-worker-blocked": ("both", 1), "C4-worker-lied": ("antidetect", 4), "C4-dedicated-worker-only": ("both", 1),
    "C12-worker-scope-vs-page": ("antidetect", 4), "C12-worker-ua-vs-http-ua": ("antidetect", 4),
    "C5-features-vs-version": ("antidetect", 4), "C6-bot-pattern": ("both", 1), "C7-privacy-browser": ("antidetect", 0),
    "C7-fp-extension": ("antidetect", 2), "C8-trash-values": ("both", 1), "C9-webgl-suspect": ("antidetect", 2),
    "C10-timezone-lied": ("antidetect", 3), "F1-fpjs-id-unstable": ("antidetect", 3),
}

# cohort -> tool -> flag probabilities (invented)
PROFILES = {
    "C1": {"chrome-win": {"C1-prototype-lies": .005, "X4-language-vs-ip-country": .05, "J12-timezone-vs-ip": .01, "B2-dead-centre-click": .004},
           "safari-mac": {"X4-language-vs-ip-country": .04}, "chrome-android": {"J12-timezone-vs-ip": .01}},
    "C2": {"brave": {"C7-privacy-browser": 1, "C1-prototype-lies": .4, "C11-component-lied": .3, "J5-patched-apis": .03, "X4-language-vs-ip-country": .1},
           "tor": {"C7-privacy-browser": 1, "C4-worker-blocked": .6, "H4-rtt-gap": .9, "N3-datacenter-asn": .7, "J12-timezone-vs-ip": .6, "X4-language-vs-ip-country": .5},
           "firefox-rfp": {"C7-privacy-browser": 1, "C10-timezone-lied": .05, "J6-canvas-noise": .04, "J12-timezone-vs-ip": .3}},
    "C3": {"chatgpt-cloud": {"C2-like-headless": .7, "C9-webgl-suspect": .6, "C12-worker-ua-vs-http-ua": .3, "N3-datacenter-asn": .95, "J4-software-gpu": .9, "X1-ua-vs-client-hints": .85,
                             "J10-linux-fonts": .9, "J10-fonts-vs-ua-os": .8, "B2-dead-centre-click": .5},
           "browserbase": {"C2-headless-traits": .5, "C3-stealth-patches": .4, "C6-bot-pattern": .4, "N3-datacenter-asn": .95, "J1-webdriver": .4, "J4-software-gpu": .7, "B1-pointer-jump": .6}},
    "C4": {"playwright-headless": {"C2-headless-traits": .9, "C2-like-headless": .8, "C6-bot-pattern": .5, "J1-webdriver": .97, "J3-headless-ua": .6, "J4-software-gpu": .8, "B1-pointer-jump": .8,
                                   "B2-dead-centre-click": .5, "J2-cdp-runtime": .1},
           "comet": {"C2-like-headless": .1, "B1-pointer-jump": .4, "B2-dead-centre-click": .35, "B3-untrusted-events": .25}},
    "C5": {"chatgpt-user": {"N8-no-javascript": 1, "N2-declared-bot-verified": .95, "N3-datacenter-asn": .95},
           "perplexity-user": {"N8-no-javascript": 1, "N2-declared-bot-verified": .9, "N3-datacenter-asn": .95}},
    "C6": {"adspower": {"C1-prototype-lies": .9, "C1-many-lies": .5, "C11-component-lied": .7, "C12-worker-scope-vs-page": .5, "F1-fpjs-id-unstable": .6, "C5-features-vs-version": .2, "J5-patched-apis": .8, "J6-canvas-noise": .7, "J8-worker-vs-page": .5, "J11-webrtc-ip-mismatch": .6,
                        "H4-rtt-gap": .7, "J7-audio-noise": .5, "X3-ttl-vs-ua-os": .4},
           "dolphin": {"C1-prototype-lies": .8, "C11-component-lied": .6, "C5-features-vs-version": .6, "C4-worker-lied": .4, "F1-fpjs-id-unstable": .7, "J5-patched-apis": .6, "J6-canvas-noise": .8, "J9-engine-older-than-claimed": .6, "H4-rtt-gap": .6,
                       "J12-timezone-vs-ip": .3, "J7-gpu-vs-ua-os": .3},
           "gologin": {"C1-prototype-lies": .7, "C12-worker-scope-vs-page": .6, "C12-worker-ua-vs-http-ua": .4, "C10-timezone-lied": .3, "F1-fpjs-id-unstable": .4, "J8-worker-vs-page": .7, "J6-canvas-noise": .5, "J5-patched-apis": .5, "H4-rtt-gap": .65,
                       "J10-fonts-vs-ua-os": .4}},
}

# Real people's devices are internally consistent: OS, GPU, fonts, TCP stack and
# TTL travel together. (os, renderer, fonts, ja4t, ttl choices, cores)
WIN_FONTS = {"Windows": ["Consolas", "Tahoma", "Marlett"], "macOS": [], "Linux": []}
MAC_FONTS = {"Windows": [], "macOS": ["Menlo", "Monaco", "Avenir"], "Linux": []}
AND_FONTS = {"Windows": [], "macOS": [], "Linux": ["Noto Color Emoji"]}
WIN_JA4T, MAC_JA4T, AND_JA4T = "64240_2-4-8-1-3_1460_8", "65535_2-1-3-1-1-8-4-0-0_1460_6", "65535_2-4-8-1-3_1440_7"
DEVICES = [
    ("Windows", "ANGLE (Intel, Iris Xe)", WIN_FONTS, WIN_JA4T, (113, 117), 8),
    ("Windows", "ANGLE (Intel, UHD Graphics 620)", WIN_FONTS, WIN_JA4T, (113, 117), 4),
    ("Windows", "ANGLE (NVIDIA, GeForce GTX 1650)", WIN_FONTS, WIN_JA4T, (113, 117), 12),
    ("Windows", "ANGLE (AMD, Radeon RX 6600)", WIN_FONTS, WIN_JA4T, (113, 117), 16),
    ("macOS", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1)", MAC_FONTS, MAC_JA4T, (52, 57), 8),
    ("macOS", "ANGLE (Apple, ANGLE Metal Renderer: Apple M2)", MAC_FONTS, MAC_JA4T, (52, 57), 8),
    ("Android", "Adreno (TM) 650", AND_FONTS, AND_JA4T, (52, 55), 8),
    ("Android", "Mali-G78", AND_FONTS, AND_JA4T, (52, 55), 8),
]
UA_BY_OS = {"Windows": "Windows NT 10.0; Win64; x64", "macOS": "Macintosh; Intel Mac OS X 10_15_7",
            "Android": "Linux; Android 14; Pixel 8"}
TOOL_OS = {"chrome-win": ["Windows"], "safari-mac": ["macOS"], "chrome-android": ["Android"],
           "brave": ["Windows", "macOS"], "firefox-rfp": ["Windows", "macOS"], "tor": ["Windows", "macOS"]}
COMPONENTS = ["canvas2d", "canvasWebgl", "canvasWebglParameters", "offlineAudioContext", "fonts", "voices", "maths",
              "consoleErrors", "css", "styleSystem", "cssMedia", "screen", "svg", "domRect", "intl", "media",
              "mimeTypes", "windowFeatures", "htmlElementVersion", "navigator", "workerScope", "timezone", "features",
              "headless", "resistance", "deviceOfTimezone"]
NOISY = {"canvas2d", "canvasWebgl", "offlineAudioContext", "domRect", "svg"}  # what anti-detect noise changes


def _h(*parts) -> str:
    import hashlib
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()


RENDERERS = ["ANGLE (Intel, Iris Xe)", "ANGLE (Intel, UHD Graphics 620)", "ANGLE (NVIDIA, GeForce GTX 1650)",
             "ANGLE (AMD, Radeon RX 6600)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1)",
             "ANGLE (Apple, ANGLE Metal Renderer: Apple M2)", "Adreno (TM) 650", "Mali-G78"]
FONT_SETS = [{"Windows": ["Consolas", "Tahoma"], "macOS": [], "Linux": []},
             {"Windows": [], "macOS": ["Menlo", "Monaco", "Avenir"], "Linux": []},
             {"Windows": ["Consolas", "Tahoma", "Marlett"], "macOS": [], "Linux": []},
             {"Windows": [], "macOS": [], "Linux": []}]

SCHEMA = """
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, url TEXT NOT NULL, cohort TEXT, tool TEXT, note TEXT,
  one_time INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, link_id TEXT NOT NULL, t0 INTEGER, t1 INTEGER, t3 INTEGER,
  t5 INTEGER, ip TEXT, server TEXT, client TEXT, rtt TEXT, verdict TEXT);
"""


def _id(rng: random.Random, n: int) -> str:
    return "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(n))


def _probes(rng: random.Random, cohort: str, tool: str, fired: list[str], dev: tuple, chrome: int, ua: str,
            machine: dict | None, i: int) -> tuple[dict, dict]:
    """A CreepJS summary and a FingerprintJS result shaped like client/probes.js and stop.js send them."""
    d_os, d_gl, _, _, _, d_hc = dev
    # One hardware+software build per device model and browser version; people
    # with the same laptop and browser share most component hashes.
    build = (d_os, d_gl, chrome if rng.random() < 0.85 else chrome - 1)
    noise = cohort == "C6" and any(f in fired for f in ("F1-fpjs-id-unstable", "C11-component-lied"))
    hashes = {}
    for c in COMPONENTS:
        if noise and c in NOISY:
            hashes[c] = _h(c, rng.random())
        elif c in ("navigator", "workerScope") and cohort == "C6":
            hashes[c] = _h(c, d_os, rng.randrange(6))     # rotated profile values
        elif c == "screen":
            hashes[c] = _h(c, d_os, rng.randrange(3))
        elif c == "timezone":
            hashes[c] = _h(c, "America/New_York")
        else:
            hashes[c] = _h(c, *build)
    lies = 0
    if "C1-prototype-lies" in fired:
        lies = rng.randrange(20, 90) if "C1-many-lies" in fired else rng.randrange(1, 19)
    headless = rng.choice([17, 33, 50]) if "C2-headless-traits" in fired else 0
    like = rng.choice([72, 83, 94]) if "C2-like-headless" in fired else rng.choice([17, 22, 28, 56])
    stealth = rng.choice([20, 40]) if "C3-stealth-patches" in fired else 0
    blocked = "C4-worker-blocked" in fired
    priv = {"brave": "Brave", "tor": "Tor Browser", "firefox-rfp": "Firefox"}.get(tool)
    stable_id = _h("creep", machine["renderer"], machine["ja4t"]) if machine and rng.random() < 0.6 else _h("creep", *build, d_hc)
    fp_id = _h("fpjs", rng.random()) if (noise or cohort == "C6") else _h("fpjs", *build, d_hc, i % 7 if cohort in ("C1", "C2") else 0)
    creep = {
        "source": "creepjs@10aa672", "ms": rng.randrange(900, 3500), "fpId": stable_id, "looseId": _h(rng.random()),
        "fuzzy": stable_id[:32] + _h(rng.random())[:32],
        "bot": {"hash": "0" * 8, "badBot": None} if "C6-bot-pattern" not in fired else {"hash": "00010000", "badBot": "outsideFeaturesVersion"},
        "lied": (["canvas2d", "offlineAudioContext"] if "C11-component-lied" in fired else []),
        "lies": {"total": lies, "apis": (["CanvasRenderingContext2D.getImageData", "Navigator.userAgent"][: 1 + (lies > 5)] if lies else [])},
        "headless": {"headless": headless, "likeHeadless": like, "stealth": stealth},
        "resistance": {"privacy": priv, "mode": None, "extension": None},
        "worker": None if blocked else {"type": "service", "lied": "C4-worker-lied" in fired, "userAgent": ua,
                                        "platform": {"Windows": "Win32", "macOS": "MacIntel", "Android": "Linux armv81"}[d_os],
                                        "hardwareConcurrency": d_hc},
        "gpu": {"renderer": d_gl, "confidence": "low" if "C9-webgl-suspect" in fired else "high"},
        "hashes": hashes,
    }
    fpjs = {"visitorId": fp_id, "second": _h("fpjs2", rng.random()) if "F1-fpjs-id-unstable" in fired else fp_id,
            "confidence": 0.4, "version": "5.3.0"}
    return creep, fpjs


def make_demo_db(path: str | Path, per_tool: int = 40, days: int = 42, seed: int = 1) -> Path:
    rng = random.Random(seed)
    path = Path(path)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    start = datetime(2026, 9, 14, tzinfo=timezone.utc)
    # One shared machine behind each anti-detect tool: stable values stay put, claimed ones rotate.
    machines = {t: {"ja4t": f"64240_2-4-8-1-3_1460_{rng.choice([7, 8])}", "ttl": 117, "renderer": f"ANGLE (NVIDIA, GeForce RTX {rng.choice([3060, 4070])})",
                    "fonts": json.dumps({"Windows": ["Consolas", "Tahoma"], "macOS": [], "Linux": []}), "asn": 7922, "hc": 16}
                for t in PROFILES["C6"]}
    for cohort, tools in PROFILES.items():
        for tool, probs in tools.items():
            for i in range(per_tool):
                day = start + timedelta(days=rng.randrange(days), minutes=rng.randrange(600))
                link = _id(rng, 8)
                con.execute("INSERT INTO links VALUES (?,?,?,?,?,?,?,?)",
                            (link, "https://www.youtube.com/watch?v=demo", cohort, tool, None, 1, 1, int(day.timestamp() * 1000)))
                fired = [f for f, p in probs.items() if rng.random() < p]
                js = "N8-no-javascript" not in fired
                t0 = int(day.timestamp() * 1000) + 500
                tcp = rng.uniform(8, 60) if cohort in ("C1", "C2", "C4", "C6") else rng.uniform(1, 15)
                gap = (rng.uniform(60, 200) if "H4-rtt-gap" in fired else rng.lognormvariate(1.0, 0.6))
                m = machines.get(tool)
                if cohort in ("C1", "C2"):
                    dev = rng.choice([d for d in DEVICES if d[0] in TOOL_OS[tool]])
                elif cohort == "C6":   # profile claims any OS; the machine below stays Windows/NVIDIA
                    dev = (rng.choice(["Windows", "macOS"]), m["renderer"], json.loads(m["fonts"]), m["ja4t"], (m["ttl"],), m["hc"])
                else:                  # cloud / automation hosts: Linux machines claiming a desktop OS
                    dev = (rng.choice(["Windows", "macOS"]), "ANGLE (Google, SwiftShader)" if "J4-software-gpu" in fired
                           else rng.choice(["ANGLE (Intel, UHD Graphics 620)", "ANGLE (Mesa, llvmpipe)"]),
                           {"Windows": [], "macOS": [], "Linux": ["DejaVu Sans", "Liberation Mono"]}, AND_JA4T, (52, 57), 4)
                d_os, d_gl, d_fonts, d_ja4t, d_ttls, d_hc = dev
                chrome = rng.choice([136, 137, 138])
                ua = f"Mozilla/5.0 ({UA_BY_OS[d_os]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome}.0.0.0 Safari/537.36"
                server = {
                    "ip": f"203.0.{rng.randrange(256)}.{rng.randrange(1, 255)}",
                    "userAgent": ua, "secChUaPlatform": f'"{d_os}"',
                    "ja4": f"t13d1516h2_8daaf6152771_{_id(rng, 12).lower() if cohort == 'C6' else 'e5627efa2ab1'}",
                    "ja4h": f"ge11cn{rng.randrange(10, 20)}enus_{_id(rng, 12).lower()}", "ja4t": d_ja4t,
                    "synTtl": rng.choice(d_ttls), "synHops": rng.randrange(6, 14),
                    "tcpRttUs": int(tcp * 1000),
                    "signature": {"type": "verified-agent", "agent": "chatgpt"} if tool == "chatgpt-cloud" else {"type": "none"},
                    "geo": {"country": "US", "asn": m["asn"] if m else (16509 if "N3-datacenter-asn" in fired else rng.choice([7922, 7018, 701, 20115, 22773, 209])),
                            "asOrg": "AMAZON-02" if "N3-datacenter-asn" in fired else "COMCAST-7922",
                            "hosting": "N3-datacenter-asn" in fired, "citySource": "maxmind"},
                    "declaredBot": {"token": "ChatGPT-User", "status": "verified"} if "N2-declared-bot-verified" in fired else None,
                }
                client = None
                if js:
                    client = {"flags": [], "raw": {
                        "webgl": {"renderer": d_gl},
                        "canvasHash": _id(rng, 8).lower() if cohort == "C6" else "a1b2c3d4",
                        "fonts": d_fonts,
                        "nonNative": ([f"{tool}-hook", "get userAgent"] if "J5-patched-apis" in fired else []),
                        "hardwareConcurrency": d_hc, "tzOffset": 300,
                        "screen": {"w": rng.choice([1920, 1536, 2560]), "h": rng.choice([1080, 864, 1440])}},
                        "behaviour": {"moves": rng.randrange(0, 80), "click": {"trusted": True, "offsetPx": rng.uniform(0, 30)}},
                        "forward": {"t4ClientMs": rng.uniform(800, 9000)}}
                if client is not None:
                    client["raw"]["creep"], client["raw"]["fpjs"] = _probes(rng, cohort, tool, fired, dev, chrome, ua, m, i)
                flags = [{"id": f, "side": FLAGS[f][0], "w": FLAGS[f][1]} for f in fired]
                if client is not None:
                    client["flags"] = [f for f in flags if f["id"] not in ("N8-no-javascript", "N2-declared-bot-verified")]
                score = lambda side: sum(f["w"] for f in flags if f["side"] in (side, "both"))  # noqa: E731
                verdict = {"verifiedAgent": "chatgpt" if tool == "chatgpt-cloud" else None,
                           "suspectedAgent": score("agent") >= 5, "antiDetect": score("antidetect") >= 5,
                           "agentScore": score("agent"), "antiDetectScore": score("antidetect"), "flags": flags,
                           "hop": {"tcpRttMs": tcp, "pageRttMinMs": tcp + gap if js else None, "gapMs": gap if js else None,
                                   "synTtl": server["synTtl"], "synHops": server["synHops"], "geoFloorMs": None}}
                rtt = {"samplesMs": [round(tcp + gap + rng.uniform(0, 3), 3) for _ in range(10)]} if js else None
                con.execute("INSERT INTO visits VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                    _id(rng, 16), link, t0, t0 + 4, (t0 + rng.randrange(80, 900)) if js else None,
                    (t0 + rng.randrange(1500, 9000)) if js else None, server["ip"],
                    json.dumps(server), json.dumps(client) if client else None, json.dumps(rtt) if rtt else None, json.dumps(verdict)))
    con.commit()
    con.close()
    return path
