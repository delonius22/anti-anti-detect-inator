// Test N2: bots that announce themselves in the User-Agent, checked against the
// IP lists their operators publish. A token alone is only a claim: anyone can
// send "ChatGPT-User". The IP check turns the claim into a verified identity.
//
// scripts/update-bot-ips.js downloads the lists into BOT_IPS_FILE.

import fs from "node:fs";
import net from "node:net";

export const DECLARED_BOTS = [
  // operator-published lists (URLs from the operators' own bot documentation)
  { token: "ChatGPT-User", operator: "OpenAI", kind: "user-fetcher", list: "https://openai.com/chatgpt-user.json" },
  { token: "OAI-SearchBot", operator: "OpenAI", kind: "search", list: "https://openai.com/searchbot.json" },
  { token: "GPTBot", operator: "OpenAI", kind: "training", list: "https://openai.com/gptbot.json" },
  { token: "OAI-AdsBot", operator: "OpenAI", kind: "ads", list: "https://openai.com/adsbot.json" },
  { token: "Perplexity-User", operator: "Perplexity", kind: "user-fetcher", list: "https://www.perplexity.com/perplexity-user.json" },
  { token: "PerplexityBot", operator: "Perplexity", kind: "search", list: "https://www.perplexity.com/perplexitybot.json" },
  { token: "Googlebot", operator: "Google", kind: "search", list: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
  { token: "bingbot", operator: "Microsoft", kind: "search", list: "https://www.bing.com/toolbox/bingbot.json" },
  // tokens without a list wired in here: reported as claims only
  { token: "Claude-User", operator: "Anthropic", kind: "user-fetcher" },
  { token: "ClaudeBot", operator: "Anthropic", kind: "training" },
  { token: "MistralAI-User", operator: "Mistral", kind: "user-fetcher" },
  { token: "GrokBot", operator: "xAI", kind: "unknown" },
  { token: "xAI-Grok", operator: "xAI", kind: "unknown" },
  { token: "Grok-DeepSearch", operator: "xAI", kind: "unknown" },
];

// Pull every CIDR string out of a JSON document, whatever its shape
// (Google-style {"prefixes":[{"ipv4Prefix": ...}]} or plain arrays).
export function extractCidrs(doc) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const [ip, len] = v.split("/");
      if (len !== undefined && net.isIP(ip) && /^\d+$/.test(len)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return out;
}

export function loadDeclaredBots(file = process.env.BOT_IPS_FILE || "/var/lib/capture-app/bot-ips.json") {
  let lists = {};
  try { lists = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* no lists yet: claims only */ }
  const blocks = new Map();
  for (const bot of DECLARED_BOTS) {
    const cidrs = lists[bot.token]?.cidrs;
    if (!cidrs?.length) continue;
    const bl = new net.BlockList();
    for (const c of cidrs) {
      const [ip, len] = c.split("/");
      try { bl.addSubnet(ip, Number(len), net.isIPv6(ip) ? "ipv6" : "ipv4"); } catch { /* skip bad entry */ }
    }
    blocks.set(bot.token, bl);
  }

  return function matchDeclaredBot(userAgent = "", ip = "") {
    const bot = DECLARED_BOTS.find((b) => new RegExp(`\\b${b.token.replace(/[-]/g, "\\-")}\\b`, "i").test(userAgent));
    if (!bot) return null;
    const bl = blocks.get(bot.token);
    const fam = net.isIPv6(ip) ? "ipv6" : net.isIPv4(ip) ? "ipv4" : null;
    let status = "claimed";            // token seen, nothing to check against
    if (bl && fam) status = bl.check(ip, fam) ? "verified" : "spoofed"; // list exists, IP not on it
    return { token: bot.token, operator: bot.operator, kind: bot.kind, status };
  };
}
