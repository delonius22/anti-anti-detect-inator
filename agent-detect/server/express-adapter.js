// Express glue: verifies every request, exposes the verdict to your routes as
// req.agent, and serves GET /__agent so page JavaScript can learn the verdict.
//
// Why an endpoint: page JS cannot read the headers of the request that loaded
// the page. ChatGPT's cloud browser signs its fetch/XHR requests too, so the
// server re-verifies the signature on the /__agent call itself.

import { identifyAgent } from "./identify-agent.js";

export function toFetchRequest(req) {
  // Use the public host/scheme the agent actually signed, not your internal one.
  // Only trust X-Forwarded-* if they are set by your own proxy/CDN (app.set("trust proxy", ...)).
  const proto = req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return new Request(`${proto}://${host}${req.originalUrl}`, { method: req.method, headers });
}

export function agentMiddleware() {
  return async (req, res, next) => {
    try {
      req.agent = await identifyAgent(toFetchRequest(req));
    } catch (e) {
      req.agent = { type: "none", reason: "verifier-error: " + e.message };
    }
    if (req.agent.type !== "none") res.setHeader("Vary", "Signature, Signature-Input, Signature-Agent");
    next();
  };
}

export function agentStatusRoute(app) {
  app.get("/__agent", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(req.agent);
  });
}
