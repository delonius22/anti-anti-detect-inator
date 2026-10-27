// Minimal demo: node server/demo.js, then open http://localhost:3000
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentMiddleware, agentStatusRoute } from "./express-adapter.js";

const root = path.dirname(fileURLToPath(import.meta.url));
// One row per page report, in SQLite next to the server (override with DEMO_DB_PATH).
// Everything except created_at comes from the visitor and is untrusted; escape it before rendering.
// Rows hold IP addresses, which are personal data in many places: set DEMO_RETENTION_DAYS
// to delete reports older than that (checked at startup and hourly). Unset keeps everything.
export function openReports(dbPath = process.env.DEMO_DB_PATH || path.join(root, "../demo.db"),
                            { retentionDays = Number(process.env.DEMO_RETENTION_DAYS) || 0 } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
      ip TEXT, user_agent TEXT, verdict TEXT, server TEXT, client TEXT);
    CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);
  `);
  const insert = db.prepare(`INSERT INTO reports (created_at, ip, user_agent, verdict, server, client)
                             VALUES (?, ?, ?, ?, ?, ?)`);
  const add = ({ ip, userAgent, verdict, server, client }) =>
    insert.run(Date.now(), ip ?? null, userAgent ?? null, verdict ?? null, JSON.stringify(server), JSON.stringify(client));
  if (retentionDays > 0) {
    const prune = db.prepare("DELETE FROM reports WHERE created_at < ?");
    const pruneOld = () => prune.run(Date.now() - retentionDays * 86_400_000);
    pruneOld();
    setInterval(pruneOld, 3_600_000).unref();
  }
  return { db, add };
}

const VERDICTS = new Set(["verified-agent", "suspected-agent", "no-evidence"]); // detectAgent()'s outputs

export function createApp(opts = {}) {
const app = express();
const reports = opts.reports ?? openReports(opts.dbPath);
// X-Forwarded-* are honoured only from these addresses. Default: a proxy on this machine.
// Behind a CDN, set TRUST_PROXY to its address ranges (comma-separated IPs/CIDRs).
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");

app.use(agentMiddleware());
agentStatusRoute(app);

// Server-side decisions belong here, e.g.:
app.post("/checkout", (req, res) => {
  if (req.agent.type === "verified-agent") {
    // Any Web Bot Auth signer verifies; req.agent.known is true only for KNOWN_SIGNERS
    // (identify-agent.js). e.g. require human confirmation, or route to an agent-friendly flow
  }
  res.sendStatus(204);
});

// application/json only: other sites can't send it without a CORS preflight, which this app never
// approves, so they can't make their visitors' browsers post fake reports. nginx/demo.conf
// rate-limits this path; any client can still post made-up reports directly, so treat them as untrusted.
app.post("/__agent/report", express.json({ type: "application/json", limit: "16kb" }), (req, res) => {
  if (!req.is("application/json")) return res.sendStatus(415); // express.json leaves {} for other types
  const client = req.body;
  if (!client || typeof client !== "object" || Array.isArray(client)) return res.sendStatus(400);
  reports.add({ ip: req.ip, userAgent: req.get("user-agent"), server: req.agent, client,
                verdict: VERDICTS.has(client.verdict) ? client.verdict : null });
  res.sendStatus(204);
});

app.get("/agent-detect.js", (req, res) => res.sendFile(path.join(root, "../client/agent-detect.js")));
app.get("/", (req, res) => res.type("html").send(`<!doctype html><meta charset="utf-8">
<title>Agent detect demo</title>
<script type="module">
  import { detectAgent } from "/agent-detect.js";
  // The verdict is beaconed to /__agent/report and stored server-side; nothing is rendered or kept on window.
  await detectAgent({ reportUrl: "/__agent/report", behaviourMs: Number(new URLSearchParams(location.search).get("ms") || 8000) });
</script>`));

// Express's default handler sends stack traces outside production; bad JSON gets a bare status.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.sendStatus(status);
});

return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Loopback by default so traffic has to come through nginx/demo.conf and its rate limits.
  // HOST=0.0.0.0 exposes the app directly, without them.
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || "127.0.0.1";
  createApp().listen(port, host, () => console.log(`demo on http://${host}:${port}`));
}
