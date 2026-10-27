// Downloads the operator-published IP lists for test N2 into BOT_IPS_FILE.
// A list that fails to download keeps its previous contents.
//   node scripts/update-bot-ips.js
import fs from "node:fs";
import { DECLARED_BOTS, extractCidrs } from "../server/declared-bots.js";

const file = process.env.BOT_IPS_FILE || "/var/lib/capture-app/bot-ips.json";
let current = {};
try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

for (const bot of DECLARED_BOTS.filter((b) => b.list)) {
  try {
    const res = await fetch(bot.list, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cidrs = extractCidrs(await res.json());
    if (!cidrs.length) throw new Error("no CIDRs found");
    current[bot.token] = { url: bot.list, fetchedAt: new Date().toISOString(), cidrs };
    console.log(`${bot.token}: ${cidrs.length} ranges`);
  } catch (e) {
    console.error(`${bot.token}: ${e.message}${current[bot.token] ? " (keeping previous list)" : ""}`);
  }
}
fs.writeFileSync(file + ".new", JSON.stringify(current, null, 1));
fs.renameSync(file + ".new", file);
