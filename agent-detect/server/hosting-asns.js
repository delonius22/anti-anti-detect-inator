// Heuristic "is this IP in a hosting / cloud network?" for test N3.
// GeoLite2 and DB-IP Lite do not include a connection-type field, so this
// combines a short list of well-known hosting ASNs with keywords in the AS
// organisation name. Extend the list from your own cohort data.
// It cannot tell a residential proxy from a real home connection.

export const HOSTING_ASNS = new Map([
  [16509, "Amazon (AWS)"], [14618, "Amazon (AWS)"],
  [15169, "Google"], [396982, "Google Cloud"],
  [8075, "Microsoft (Azure)"],
  [14061, "DigitalOcean"], [24940, "Hetzner"], [16276, "OVH"],
  [63949, "Akamai / Linode"], [20473, "Vultr (Choopa)"], [31898, "Oracle Cloud"],
  [45102, "Alibaba Cloud"], [132203, "Tencent Cloud"], [13335, "Cloudflare"],
  [12876, "Scaleway"], [51167, "Contabo"], [60781, "Leaseweb"], [9009, "M247"],
]);

const KEYWORDS = /\b(hosting|cloud|data ?cent(er|re)|datacenter|server|vps|colo(cation)?|dedicated)\b/i;

export function classifyAsn(asn, org = "") {
  if (HOSTING_ASNS.has(asn)) return { hosting: true, reason: `known: ${HOSTING_ASNS.get(asn)}` };
  if (KEYWORDS.test(org)) return { hosting: true, reason: `keyword in "${org}"` };
  return { hosting: false, reason: null };
}
