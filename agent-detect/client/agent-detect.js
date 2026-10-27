// Client-side AI-agent signals.
//
// Two layers:
//   1. verified  – asks the server (/__agent), which checks the Web Bot Auth
//                  signature. This is the only signal that can NAME ChatGPT's
//                  cloud browser. Page JS cannot see request headers itself.
//   2. suspected – heuristics that run in the page. They catch cloud/headless
//                  browsers and automation, not a specific product, and any
//                  client can fake or strip them. Use them for analytics and
//                  to decide when to step up (CAPTCHA, re-auth), never to
//                  grant access.
//
// Usage:
//   import { detectAgent } from "/agent-detect.js";
//   const verdict = await detectAgent({ reportUrl: "/__agent/report" });

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|mesa offscreen|microsoft basic render/i;

function uaClaimedOS(ua) {
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "Chrome OS";
  if (/Linux/.test(ua)) return "Linux";
  return "unknown";
}

function glRenderer() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return { renderer: null, vendor: null };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    };
  } catch { return { renderer: null, vendor: null }; }
}

// True when a DevTools Protocol client has the Runtime domain enabled
// (Puppeteer, Playwright, many agent harnesses — and humans with DevTools open).
// Fragile: Chrome has changed console serialization before. Treat as a hint.
function cdpRuntimeActive() {
  let hit = false;
  try {
    const e = new Error();
    Object.defineProperty(e, "stack", { configurable: true, get() { hit = true; return ""; } });
    console.debug(e);
  } catch {}
  return hit;
}

function staticSignals() {
  const s = [];
  const ua = navigator.userAgent;
  const claimed = uaClaimedOS(ua);

  if (navigator.webdriver === true) s.push({ id: "webdriver", w: 5 });

  // ChatGPT's cloud browser was observed sending a macOS Chrome UA while its
  // Client Hints said "Linux". userAgentData reflects the Client Hints value.
  const chPlatform = navigator.userAgentData?.platform;
  if (chPlatform && claimed !== "unknown") {
    const norm = { "macOS": "macOS", "Windows": "Windows", "Linux": "Linux", "Android": "Android", "Chrome OS": "Chrome OS", "Chromium OS": "Chrome OS" }[chPlatform] || chPlatform;
    if (norm !== claimed) s.push({ id: "ua-vs-client-hints-os", w: 4, detail: `${claimed} vs ${chPlatform}` });
  }
  const navPlat = navigator.platform || "";
  if ((claimed === "macOS" && !/Mac/.test(navPlat)) || (claimed === "Windows" && !/Win/.test(navPlat))) {
    s.push({ id: "ua-vs-navigator-platform", w: 3, detail: `${claimed} vs ${navPlat}` });
  }

  const gl = glRenderer();
  if (!gl.renderer) s.push({ id: "no-webgl", w: 1 });
  else if (SOFTWARE_GL.test(gl.renderer)) s.push({ id: "software-gpu", w: 2, detail: gl.renderer }); // GPU-less VM: cloud browsers, headless
  if (gl.renderer && claimed === "macOS" && !/apple|amd|intel|radeon|nvidia/i.test(gl.renderer)) {
    s.push({ id: "gpu-vs-ua-os", w: 2, detail: gl.renderer });
  }

  if (/HeadlessChrome/.test(ua)) s.push({ id: "headless-ua", w: 5 });
  if (window.outerWidth === 0 || window.outerHeight === 0) s.push({ id: "zero-outer-window", w: 2 });
  if (screen.width === 800 && screen.height === 600) s.push({ id: "default-headless-screen", w: 1 });
  if (navigator.languages && navigator.languages.length === 0) s.push({ id: "no-languages", w: 2 });
  if (cdpRuntimeActive()) s.push({ id: "cdp-runtime", w: 3 });

  return s;
}

// Behaviour over the first N seconds. Agents driving the page via CDP or by
// injecting JS tend to click without moving the pointer, click dead-centre,
// fire untrusted events, or fill inputs with no key events.
function watchBehaviour(ms) {
  return new Promise((resolve) => {
    const st = { moves: 0, clicks: 0, clicksNoMove: 0, centred: 0, untrusted: 0,
                 inputsNoKeys: 0, keys: 0, keyGaps: [], lastKey: 0, lastMove: 0 };
    const opts = { capture: true, passive: true };
    const onMove = (e) => { if (!e.isTrusted) st.untrusted++; st.moves++; st.lastMove = performance.now(); };
    const onClick = (e) => {
      if (!e.isTrusted) st.untrusted++;
      st.clicks++;
      if (performance.now() - st.lastMove > 2000) st.clicksNoMove++;
      const t = e.target instanceof Element ? e.target.getBoundingClientRect() : null;
      if (t && t.width > 8 && Math.abs(e.clientX - (t.left + t.width / 2)) < 1 && Math.abs(e.clientY - (t.top + t.height / 2)) < 1) st.centred++;
    };
    const onKey = (e) => {
      if (!e.isTrusted) st.untrusted++;
      const now = performance.now();
      if (st.lastKey) st.keyGaps.push(now - st.lastKey);
      st.lastKey = now; st.keys++;
    };
    const onInput = (e) => { if (e.inputType === "insertText" || e.inputType === "insertFromPaste") return; if (st.keys === 0) st.inputsNoKeys++; };
    addEventListener("pointermove", onMove, opts);
    addEventListener("click", onClick, opts);
    addEventListener("keydown", onKey, opts);
    addEventListener("input", onInput, opts);
    setTimeout(() => {
      removeEventListener("pointermove", onMove, opts);
      removeEventListener("click", onClick, opts);
      removeEventListener("keydown", onKey, opts);
      removeEventListener("input", onInput, opts);
      const s = [];
      if (st.untrusted) s.push({ id: "untrusted-events", w: 4, detail: st.untrusted });
      if (st.clicks >= 2 && st.clicksNoMove === st.clicks) s.push({ id: "clicks-without-pointer-movement", w: 3 });
      if (st.clicks >= 2 && st.centred === st.clicks) s.push({ id: "pixel-centred-clicks", w: 3 });
      if (st.inputsNoKeys) s.push({ id: "input-without-keystrokes", w: 2 });
      if (st.keyGaps.length >= 8) {
        const mean = st.keyGaps.reduce((a, b) => a + b, 0) / st.keyGaps.length;
        const sd = Math.sqrt(st.keyGaps.reduce((a, b) => a + (b - mean) ** 2, 0) / st.keyGaps.length);
        if (sd / mean < 0.15) s.push({ id: "uniform-typing-cadence", w: 3, detail: `cv=${(sd / mean).toFixed(2)}` });
      }
      resolve({ signals: s, stats: { moves: st.moves, clicks: st.clicks, keys: st.keys } });
    }, ms);
  });
}

async function serverVerdict(url) {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return r.ok ? await r.json() : { type: "unknown", reason: `status ${r.status}` };
  } catch (e) { return { type: "unknown", reason: String(e) }; }
}

/**
 * @param {{statusUrl?:string, reportUrl?:string, behaviourMs?:number}} [opts]
 * @returns {Promise<{verdict:"verified-agent"|"suspected-agent"|"no-evidence",
 *   agent?:string, score:number, signals:object[], server:object}>}
 */
export async function detectAgent(opts = {}) {
  const { statusUrl = "/__agent", reportUrl, behaviourMs = 8000 } = opts;
  const [server, behaviour] = await Promise.all([serverVerdict(statusUrl), watchBehaviour(behaviourMs)]);
  const signals = [...staticSignals(), ...behaviour.signals];
  const score = signals.reduce((a, s) => a + s.w, 0);

  let verdict = "no-evidence"; // NOT proof of a human
  if (server.type === "verified-agent") verdict = "verified-agent";
  else if (score >= 5) verdict = "suspected-agent";

  const out = { verdict, agent: server.type === "verified-agent" ? server.agent : undefined,
                score, signals, server, behaviour: behaviour.stats };
  if (reportUrl) {
    try { navigator.sendBeacon(reportUrl, new Blob([JSON.stringify(out)], { type: "application/json" })); } catch {}
  }
  return out;
}

if (typeof window !== "undefined") window.detectAgent = detectAgent;
