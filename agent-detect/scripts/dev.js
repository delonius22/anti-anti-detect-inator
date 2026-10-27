// App-only local run, no nginx: node scripts/dev.js  (any OS, Node 22.13+)
// Everything except the network fingerprints works: stop page, page checks,
// WebSocket RTT, behaviour, timeline, storage, scoring. JA4, JA4T, TTL and
// TCP RTT stay empty because nginx is what measures them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = {
  ADMIN_TOKEN: "dev-token",
  PUBLIC_ORIGIN: "http://127.0.0.1:3000",
  DB_PATH: path.join(root, "dev-data", "visits.db"),
  GEOIP_DIR: path.join(root, "dev-data", "geoip"),
  BOT_IPS_FILE: path.join(root, "dev-data", "bot-ips.json"),
  STUN_URL: "",
  PORT: "3000",
};
for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
fs.mkdirSync(process.env.GEOIP_DIR, { recursive: true });

const { startServer } = await import("../server/capture-app.js");
await startServer();
console.log(`
Dev mode (no nginx). Admin token: ${process.env.ADMIN_TOKEN}
Create a link:
  curl -s -X POST ${process.env.PUBLIC_ORIGIN}/api/links -H "Authorization: Bearer ${process.env.ADMIN_TOKEN}" -H "content-type: application/json" -d "{\\"url\\":\\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\\",\\"cohort\\":\\"C1\\",\\"tool\\":\\"my-browser\\"}"
Read visits:
  curl -s -H "Authorization: Bearer ${process.env.ADMIN_TOKEN}" "${process.env.PUBLIC_ORIGIN}/api/visits?limit=1"
`);
