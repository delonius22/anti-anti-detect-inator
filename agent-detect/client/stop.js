// The Anti-Anti-Detect-inator, stop page half.
// The rendered page shows only the destination, but this file is public:
// anyone who opens /s/stop.js can read these comments and the flag names.
//
// Stop page script: runs the test plan's page checks (J1-J12), the
// CreepJS-based probes (C1-C12), the FingerprintJS device ID (F1), measures
// in-page RTT (H3, echoed over WebSocket), records Continue behaviour (B1-B3)
// and redirect timing (H6), then beacons everything under the visit ID.
// Every flag carries side: "agent" | "antidetect" | "both".
(() => {
  "use strict";
  const T_SCRIPT = performance.now();
  const VISIT = document.body.dataset.visit;
  const STUN = document.body.dataset.stun;
  const flags = [];
  const raw = {};
  const flag = (id, side, w, detail) => flags.push(detail === undefined ? { id, side, w } : { id, side, w, detail });
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
  const withTimeout = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
  const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };

  const UA = navigator.userAgent;
  const OS = /Windows NT/.test(UA) ? "Windows" : /Android/.test(UA) ? "Android" : /iPhone|iPad|iPod/.test(UA) ? "iOS"
    : /Mac OS X|Macintosh/.test(UA) ? "macOS" : /CrOS/.test(UA) ? "Chrome OS" : /Linux/.test(UA) ? "Linux" : "unknown";
  const CHROME = +((/(?:Chrome|Chromium)\/(\d+)/.exec(UA) || [])[1] || 0);

  // ---- Agent-side static checks -------------------------------------------
  if (navigator.webdriver === true) flag("J1-webdriver", "agent", 5);
  if (window.outerWidth === 0 || window.outerHeight === 0) flag("J3-zero-outer-window", "agent", 2);
  if (screen.width === 800 && screen.height === 600) flag("J3-default-headless-screen", "agent", 1);
  if (navigator.languages && navigator.languages.length === 0) flag("J3-no-languages", "agent", 2);
  safe(() => { // J2: getter fires only if a DevTools Protocol client serialises console args
    let hit = false; const e = new Error();
    Object.defineProperty(e, "stack", { configurable: true, get() { hit = true; return ""; } });
    console.debug(e);
    if (hit) flag("J2-cdp-runtime", "agent", 2);
  });

  // ---- Cross-layer checks inside the page ---------------------------------
  const uaDataPlatform = safe(() => navigator.userAgentData && navigator.userAgentData.platform);
  const chMap = { macOS: "macOS", Windows: "Windows", Linux: "Linux", Android: "Android", "Chrome OS": "Chrome OS", "Chromium OS": "Chrome OS" };
  if (uaDataPlatform && OS !== "unknown" && (chMap[uaDataPlatform] || uaDataPlatform) !== OS) flag("X1c-ua-vs-uadata", "both", 3, `${OS} vs ${uaDataPlatform}`);
  const navPlat = navigator.platform || "";
  if ((OS === "macOS" && !/Mac/.test(navPlat)) || (OS === "Windows" && !/Win/.test(navPlat))) flag("X1c-ua-vs-navigator-platform", "both", 3, `${OS} vs ${navPlat}`);

  // ---- J5 native function integrity ---------------------------------------
  safe(() => {
    const fnToString = Function.prototype.toString;
    const nativeAs = (fn, name) => typeof fn === "function" &&
      new RegExp(`^function ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(\\) \\{\\s*\\[native code\\]\\s*\\}$`).test(fnToString.call(fn));
    const getter = (proto, prop) => (Object.getOwnPropertyDescriptor(proto, prop) || {}).get;
    const checks = [
      [fnToString, "toString"],
      [getter(Navigator.prototype, "userAgent"), "get userAgent"],
      [getter(Navigator.prototype, "platform"), "get platform"],
      [getter(Navigator.prototype, "hardwareConcurrency"), "get hardwareConcurrency"],
      [getter(Navigator.prototype, "languages"), "get languages"],
      [getter(Navigator.prototype, "webdriver"), "get webdriver"],
      [getter(Screen.prototype, "width"), "get width"],
      [HTMLCanvasElement.prototype.toDataURL, "toDataURL"],
      [HTMLCanvasElement.prototype.getContext, "getContext"],
      [CanvasRenderingContext2D.prototype.getImageData, "getImageData"],
      [CanvasRenderingContext2D.prototype.measureText, "measureText"],
      [WebGLRenderingContext.prototype.getParameter, "getParameter"],
      [Date.prototype.getTimezoneOffset, "getTimezoneOffset"],
      [Intl.DateTimeFormat.prototype.resolvedOptions, "resolvedOptions"],
      [window.AudioBuffer && AudioBuffer.prototype.getChannelData, "getChannelData"],
    ].filter(([fn]) => fn);
    const bad = checks.filter(([fn, name]) => !nativeAs(fn, name)).map(([, name]) => name);
    const own = Object.getOwnPropertyNames(navigator);
    if (own.length) bad.push(`navigator own props: ${own.slice(0, 5).join(",")}`);
    raw.nonNative = bad;
    if (bad.length) flag("J5-patched-apis", "antidetect", 4, bad.slice(0, 6).join("; "));
  });

  // ---- J4 / J7 WebGL ------------------------------------------------------
  safe(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) { flag("J4-no-webgl", "agent", 1); return; }
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    raw.webgl = { renderer, vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewport: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []) };
    if (/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer)) flag("J4-software-gpu", "agent", 2, renderer);
    if (OS === "Windows" && /Metal|Apple M\d/i.test(renderer)) flag("J7-gpu-vs-ua-os", "antidetect", 3, renderer);
    if (OS === "macOS" && /Direct3D|D3D11/i.test(renderer)) flag("J7-gpu-vs-ua-os", "antidetect", 3, renderer);
  });

  // ---- J6 canvas consistency ---------------------------------------------
  safe(() => {
    const draw = () => {
      const c = document.createElement("canvas"); c.width = 240; c.height = 60;
      const x = c.getContext("2d");
      x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#f60"; x.fillRect(100, 1, 62, 20);
      x.fillStyle = "#069"; x.fillText("Cwm fjordbank glyphs vext quiz", 2, 15);
      x.fillStyle = "rgba(102,204,0,0.7)"; x.beginPath(); x.arc(50, 30, 20, 0, Math.PI * 2); x.fill();
      return c.toDataURL();
    };
    const a = draw(), b = draw();
    raw.canvasHash = hash(a);
    if (a !== b) flag("J6-canvas-noise", "antidetect", 4);
  });

  // ---- J9 engine version vs claimed Chrome version ------------------------
  if (CHROME) safe(() => {
    const probes = [[97, () => "findLast" in Array.prototype], [98, () => typeof structuredClone === "function"],
      [110, () => "toSorted" in Array.prototype], [117, () => typeof Object.groupBy === "function"],
      [119, () => typeof Promise.withResolvers === "function"], [121, () => typeof Array.fromAsync === "function"],
      [122, () => typeof Set.prototype.union === "function"], [128, () => typeof Promise.try === "function"]];
    const missing = probes.filter(([v, p]) => CHROME >= v && !p()).map(([v]) => v);
    const extra = probes.filter(([v, p]) => CHROME < v && p()).map(([v]) => v);
    if (missing.length) flag("J9-engine-older-than-claimed", "antidetect", 4, `claims ${CHROME}, lacks ${missing.join(",")}`);
    if (extra.length) flag("J9-engine-newer-than-claimed", "both", 1, `claims ${CHROME}, has ${extra.join(",")}`);
  });

  // ---- J10 fonts vs claimed OS --------------------------------------------
  // Linux fontconfig maps many Windows/macOS names (Segoe UI, Calibri, Helvetica,
  // Helvetica Neue...) to metric-compatible substitutes, so those names look
  // "installed" on Linux. The signature sets below use fonts that were not
  // aliased in testing; the Linux set catches the substitutes themselves.
  safe(() => {
    const x = document.createElement("canvas").getContext("2d");
    const probe = "mmmmmmmmmmlli1WW";
    const width = (f) => { x.font = `72px ${f}`; return x.measureText(probe).width; };
    const generics = ["monospace", "serif", "sans-serif"];
    const base = Object.fromEntries(generics.map((g) => [g, width(g)]));
    const has = (font) => generics.some((g) => width(`"${font}", ${g}`) !== base[g]);
    const sets = {
      Windows: ["Consolas", "Tahoma", "Marlett", "Segoe UI Symbol"],
      macOS: ["Menlo", "Monaco", "Avenir", "Lucida Grande", "Geneva", "Apple Color Emoji"],
      Linux: ["DejaVu Sans", "Liberation Mono", "Carlito", "Noto Color Emoji"],
    };
    const found = {}; for (const [os, list] of Object.entries(sets)) found[os] = list.filter(has);
    raw.fonts = found;
    if (OS === "Windows" || OS === "macOS") {
      if (found[OS].length === 0) flag("J10-fonts-vs-ua-os", "both", 3, `${OS} claimed, none of its fonts found; ${JSON.stringify(found)}`);
      if (found.Linux.length >= 2) flag("J10-linux-fonts", "both", 2, `${OS} claimed, Linux fonts: ${found.Linux.join(", ")}`);
    }
  });

  // ---- Async checks: J7 audio, J8 worker + iframe, J11 WebRTC -------------
  const audioOnce = () => new Promise((resolve) => {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return resolve(null);
    const ctx = new AC(1, 5000, 44100);
    const osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    ctx.oncomplete = (e) => { const d = e.renderedBuffer.getChannelData(0); let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]); resolve(s); };
    ctx.startRendering();
  });
  const audioCheck = async () => {
    const [a, b] = [await withTimeout(audioOnce(), 1500, null), await withTimeout(audioOnce(), 1500, null)];
    raw.audio = a;
    if (a !== null && b !== null && a !== b) flag("J7-audio-noise", "antidetect", 3);
  };

  const pageNav = () => ({ ua: navigator.userAgent, platform: navigator.platform, languages: (navigator.languages || []).join(","),
    hc: navigator.hardwareConcurrency, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const workerCheck = () => withTimeout(new Promise((resolve) => {
    const src = "postMessage({ua:navigator.userAgent,platform:navigator.platform,languages:(navigator.languages||[]).join(','),hc:navigator.hardwareConcurrency,tz:Intl.DateTimeFormat().resolvedOptions().timeZone})";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.onerror = () => resolve(null);
  }), 1500, null).then((wv) => {
    const pv = pageNav();
    raw.worker = wv;
    if (wv) {
      const diff = Object.keys(pv).filter((k) => String(pv[k]) !== String(wv[k]));
      if (diff.length) flag("J8-worker-vs-page", "antidetect", 4, diff.join(","));
    }
    safe(() => {
      const f = document.createElement("iframe"); f.style.display = "none"; f.srcdoc = "<!doctype html>";
      document.body.appendChild(f);
      const n = f.contentWindow.navigator;
      const iv = { ua: n.userAgent, platform: n.platform, languages: (n.languages || []).join(","), hc: n.hardwareConcurrency, tz: pv.tz };
      const diff = Object.keys(pv).filter((k) => String(pv[k]) !== String(iv[k]));
      if (diff.length) flag("J8-iframe-vs-page", "antidetect", 3, diff.join(","));
      f.remove();
    });
  });

  const webrtcCheck = () => withTimeout(new Promise((resolve) => {
    if (!window.RTCPeerConnection || !STUN) return resolve(null);
    const ips = new Set();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
    pc.createDataChannel("x");
    pc.onicecandidate = (e) => {
      if (!e.candidate) { pc.close(); return resolve([...ips]); }
      const parts = e.candidate.candidate.split(" ");
      if (parts[7] === "srflx") ips.add(parts[4]);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve(null));
  }), 2500, null).then((ips) => { raw.webrtcSrflx = ips; });

  raw.tz = safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  raw.tzOffset = new Date().getTimezoneOffset();
  raw.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio,
    iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight };
  raw.hardwareConcurrency = navigator.hardwareConcurrency;
  raw.deviceMemory = navigator.deviceMemory;

  // ---- C1-C12: CreepJS-based probes (/probes.js, vendor/creepjs) ----------
  // /probes.js runs CreepJS's collectors (prototype lies, headless/stealth
  // traits, service/shared worker scope, engine feature version, resistance,
  // trash, GPU confidence...) and resolves globalThis.__INATOR_PROBES with a
  // summary. Flags here turn that summary into the plan's evidence.
  const probeFlags = (p) => {
    raw.creep = p;
    if (!p || p.error) { flag("C0-probes-failed", "both", 0, p && p.error); return; }
    const L = p.lies || {}, H = p.headless || {}, W = p.worker, F = p.features || {}, R = p.resistance || {};
    if (L.total > 0) flag("C1-prototype-lies", "antidetect", 3, `${L.total} lies: ${(L.apis || []).slice(0, 6).join(", ")}`);
    if (L.total >= 20) flag("C1-many-lies", "antidetect", 2, L.total);
    if ((p.lied || []).length) flag("C11-component-lied", "antidetect", 3, p.lied.join(","));
    if (H.headless > 0) flag("C2-headless-traits", "agent", 4, `${H.headless}%: ${(H.headlessKeys || []).join(", ")}`);
    // likeHeadless counts traits that ordinary desktops also have (no Web Share, no
    // Contacts API...): a headed Chromium scored 56% in testing, headless 94%.
    if (H.likeHeadless >= 70) flag("C2-like-headless", "agent", 1, `${H.likeHeadless}%: ${(H.likeHeadlessKeys || []).join(", ")}`);
    if (H.stealth > 0) flag("C3-stealth-patches", "both", 4, `${H.stealth}%: ${(H.stealthKeys || []).join(", ")}`);
    if (!W || !W.userAgent) flag("C4-worker-blocked", "both", 1);
    else {
      if (W.lied) flag("C4-worker-lied", "antidetect", 4, [W.lies?.os, W.lies?.engine, W.lies?.version].filter(Boolean).join("; ") || "proto");
      if (W.type === "dedicated") flag("C4-dedicated-worker-only", "both", 1);
      // Anti-detect tools patch the page and often the dedicated worker (J8), but miss
      // the service/shared worker, which CreepJS reaches first.
      const diff = [];
      if (W.userAgent !== navigator.userAgent) diff.push("userAgent");
      if (W.hardwareConcurrency !== undefined && W.hardwareConcurrency !== navigator.hardwareConcurrency) diff.push("hardwareConcurrency");
      if (W.deviceMemory !== undefined && navigator.deviceMemory !== undefined && W.deviceMemory !== navigator.deviceMemory) diff.push("deviceMemory");
      if (W.timezoneLocation && raw.tz && W.timezoneLocation !== raw.tz) diff.push("timeZone");
      if (W.gpu?.renderer && p.gpu?.renderer && W.gpu.renderer !== p.gpu.renderer) diff.push("gpu");
      if (diff.length) flag("C12-worker-scope-vs-page", "antidetect", 4, `${W.type}: ${diff.join(",")}`);
    }
    if (F.featuresLie) flag("C5-features-vs-version", "antidetect", 4, `UA ${W?.userAgentVersion} vs css ${F.cssVersion} js ${F.jsVersion}`);
    if (p.bot?.badBot) flag("C6-bot-pattern", "both", 1, `${p.bot.badBot} (${p.bot.hash})`);
    if (R.privacy) flag("C7-privacy-browser", "antidetect", 0, `${R.privacy} ${R.mode || ""}`.trim());
    if (R.extension) flag("C7-fp-extension", "antidetect", 2, R.extension);
    if ((p.trash?.count || 0) > 0) flag("C8-trash-values", "both", 1, (p.trash.sample || []).slice(0, 3).join("; "));
    if (p.gpu && (p.gpu.parameterOrExtensionLie || p.gpu.confidence === "low")) flag("C9-webgl-suspect", "antidetect", 2,
      `${p.gpu.renderer || "?"} (confidence ${p.gpu.confidence || "?"}${p.gpu.parameterOrExtensionLie ? ", parameter lie" : ""})`);
    if (p.timezone?.lied) flag("C10-timezone-lied", "antidetect", 3, `${p.timezone.zone} measured ${p.timezone.locationMeasured}`);
  };
  const probesCheck = () => withTimeout(Promise.resolve(globalThis.__INATOR_PROBES || null), 9000, { error: "timeout" })
    .then(probeFlags, (e) => probeFlags({ error: String(e) }));

  // ---- F1: FingerprintJS v5 device ID (/s/f.js) ----------------------------
  // Two reads. A visitor ID that changes inside one page load means the browser
  // randomizes its canvas/audio/etc. per read (noise injection).
  const fpjsCheck = () => withTimeout((async () => {
    if (!window.FingerprintJS) return { error: "not loaded" };
    // The npm build pings m1.openfpcdn.io on 0.1% of loads unless monitoring is
    // off. Visitor data must not leave this site, so switch it off both ways.
    window.__fpjs_d_m = true;
    const agent = await FingerprintJS.load({ monitoring: false });
    const a = await agent.get(), b = await agent.get();
    return { visitorId: a.visitorId, second: b.visitorId, confidence: a.confidence?.score, version: a.version };
  })(), 6000, { error: "timeout" }).catch((e) => ({ error: String(e) })).then((r) => {
    raw.fpjs = r;
    if (r.visitorId && r.second && r.visitorId !== r.second) flag("F1-fpjs-id-unstable", "antidetect", 3, `${r.visitorId} then ${r.second}`);
  });

  // ---- H3: the Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-inator ----
  // The server sends 10 numbered pings; we echo each one straight back.
  safe(() => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/rtt?v=${VISIT}`);
    ws.onmessage = (e) => ws.send(e.data);
  });

  // ---- B1-B3 behaviour -----------------------------------------------------
  const beh = { moves: 0, path: 0, untrusted: 0, last: null, recent: [], pointerType: null, firstMoveAt: null };
  const onMove = (e) => {
    if (!e.isTrusted) beh.untrusted++;
    beh.pointerType = e.pointerType || beh.pointerType;
    if (beh.firstMoveAt === null) beh.firstMoveAt = performance.now();
    if (beh.last) beh.path += Math.hypot(e.clientX - beh.last.x, e.clientY - beh.last.y);
    beh.last = { x: e.clientX, y: e.clientY };
    beh.recent.push(beh.last); if (beh.recent.length > 20) beh.recent.shift();
    beh.moves++;
  };
  addEventListener("pointermove", onMove, { capture: true, passive: true });
  addEventListener("keydown", (e) => { if (!e.isTrusted) beh.untrusted++; }, { capture: true, passive: true });

  function behaviourSummary(click) {
    const r = beh.recent;
    let straight = null;
    if (r.length >= 3) {
      let len = 0; for (let i = 1; i < r.length; i++) len += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
      straight = len ? +(Math.hypot(r.at(-1).x - r[0].x, r.at(-1).y - r[0].y) / len).toFixed(3) : null;
    }
    return { moves: beh.moves, pathPx: Math.round(beh.path), straightness: straight, untrusted: beh.untrusted,
      pointerType: click?.pointerType || beh.pointerType, click };
  }

  // ---- Beacons -------------------------------------------------------------
  const nav = safe(() => performance.getEntriesByType("navigation")[0], null);
  const timing = { scriptStartMs: +T_SCRIPT.toFixed(1), responseEndMs: nav ? +nav.responseEnd.toFixed(1) : null,
    domInteractiveMs: nav ? +nav.domInteractive.toFixed(1) : null };
  const send = (extra) => {
    const body = JSON.stringify({ flags, raw, timing, ...extra });
    if (!(navigator.sendBeacon && navigator.sendBeacon(`/api/beacon/${VISIT}`, new Blob([body], { type: "application/json" })))) {
      fetch(`/api/beacon/${VISIT}`, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
    }
  };
  const asyncDone = Promise.all([audioCheck().catch(() => {}), workerCheck().catch(() => {}), webrtcCheck().catch(() => {})]);
  asyncDone.then(() => { timing.checksDoneMs = +performance.now().toFixed(1); send({ phase: "checks" }); });
  // Probes take 1-4 s; they beacon separately so a slow probe never delays the checks above.
  const probesDone = asyncDone.then(() => Promise.all([probesCheck(), fpjsCheck()]))
    .then(() => { timing.probesDoneMs = +performance.now().toFixed(1); send({ phase: "probes" }); });
  const CLICK_WAIT_MS = 2000; // fast clickers (agents) wait up to this long so their probe results are kept

  const btn = document.getElementById("continue");
  if (btn) btn.addEventListener("click", (e) => {
    e.preventDefault();
    const rect = btn.getBoundingClientRect();
    const click = { trusted: e.isTrusted, pointerType: e.pointerType || null, atMs: +performance.now().toFixed(1),
      offsetPx: +Math.hypot(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2)).toFixed(2) };
    const b = behaviourSummary(click);
    if (!e.isTrusted || beh.untrusted) flag("B3-untrusted-events", "agent", 4, beh.untrusted + (e.isTrusted ? 0 : 1));
    if (b.pointerType === "mouse" && beh.moves === 0) flag("B1-no-pointer-path", "agent", 3);
    if (b.pointerType === "mouse" && beh.moves > 0 && beh.moves < 3) flag("B1-pointer-jump", "agent", 2, beh.moves);
    if (click.offsetPx < 0.5) flag("B2-dead-centre-click", "agent", 3);
    timing.t4Ms = click.atMs;
    btn.textContent = "Continuing\u2026";
    withTimeout(probesDone, CLICK_WAIT_MS, null).then(() => {
      send({ phase: "continue", behaviour: b });
      location.href = `${btn.getAttribute("href")}?t4=${click.atMs}`;
    });
  });
})();
