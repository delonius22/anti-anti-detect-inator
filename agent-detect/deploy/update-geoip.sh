#!/usr/bin/env bash
# Refreshes the IP databases used by server/geo.js.
#   MaxMind GeoLite2 City + ASN via geoipupdate (needs /etc/GeoIP.conf with your
#   free account ID and license key). Skipped if not configured.
#   DB-IP Lite City + ASN (no account; CC BY 4.0, attribution required).
# The app re-reads changed files within an hour; no restart needed.
set -euo pipefail
GEOIP_DIR="${GEOIP_DIR:-/var/lib/capture-app/geoip}"
OWNER="${OWNER:-capture}"
install -d -m 755 "$GEOIP_DIR"

# --- MaxMind GeoLite2 (primary) ---
if [ -f /etc/GeoIP.conf ] && grep -q '^LicenseKey' /etc/GeoIP.conf && command -v geoipupdate >/dev/null; then
  geoipupdate -f /etc/GeoIP.conf -d "$GEOIP_DIR" && echo "GeoLite2 updated"
else
  echo "GeoLite2 skipped: install geoipupdate and create /etc/GeoIP.conf (DEPLOY.md step 7b)"
fi

# --- DB-IP Lite (fallback) ---
fetch_dbip() {  # $1 = city|asn
  local kind=$1 tmp month url
  tmp="$(mktemp)"
  for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do
    url="https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz"
    if curl -fsSL --retry 2 -o "$tmp" "$url"; then
      gunzip -c "$tmp" > "$tmp.mmdb" && [ -s "$tmp.mmdb" ] || { echo "bad file from $url"; continue; }
      install -m 644 "$tmp.mmdb" "$GEOIP_DIR/dbip-${kind}-lite.mmdb.new"
      mv -f "$GEOIP_DIR/dbip-${kind}-lite.mmdb.new" "$GEOIP_DIR/dbip-${kind}-lite.mmdb"
      echo "DB-IP ${kind} lite updated from ${month}"
      rm -f "$tmp" "$tmp.mmdb"; return 0
    fi
  done
  rm -f "$tmp" "$tmp.mmdb"; echo "DB-IP ${kind} lite download failed; keeping the old file"; return 1
}
fetch_dbip city || true
fetch_dbip asn || true
id "$OWNER" >/dev/null 2>&1 && chown -R "$OWNER:$OWNER" "$GEOIP_DIR"
ls -la "$GEOIP_DIR"
