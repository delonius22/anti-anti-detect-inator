// Minimal demo: node server/demo.js, then open http://localhost:3000
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { agentMiddleware, agentStatusRoute } from "./express-adapter.js";

const root = path.dirname(fileURLToPath(import.meta.url));
export function createApp() {
const app = express();
app.set("trust proxy", true); // only if a proxy/CDN you control sits in front

app.use(agentMiddleware());
agentStatusRoute(app);

// Server-side decisions belong here, e.g.:
app.post("/checkout", (req, res) => {
  if (req.agent.type === "verified-agent") {
    // e.g. require human confirmation, or route to an agent-friendly flow
  }
  res.sendStatus(204);
});

app.post("/__agent/report", express.json({ type: "*/*", limit: "16kb" }), (req, res) => {
  console.log("[agent-report]", JSON.stringify({ server: req.agent, client: req.body }));
  res.sendStatus(204);
});

app.get("/agent-detect.js", (req, res) => res.sendFile(path.join(root, "../client/agent-detect.js")));
app.get("/", (req, res) => res.type("html").send(`<!doctype html><meta charset="utf-8">
<title>Agent detect demo</title>
<pre id="out">detecting…</pre>
<script type="module">
  import { detectAgent } from "/agent-detect.js";
  const v = await detectAgent({ reportUrl: "/__agent/report", behaviourMs: Number(new URLSearchParams(location.search).get("ms") || 8000) });
  document.getElementById("out").textContent = JSON.stringify(v, null, 2);
  window.__verdict = v;
</script>`));

return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`demo on http://localhost:${port}`));
}
