#!/usr/bin/env bash
# Local/staging only: puts a self-signed certificate where nginx-measure expects
# the Let's Encrypt one, so the full stack runs in a VM with no public DNS.
#   sudo MEASURE_HOST=measure.test ./selfsigned-cert.sh
set -euo pipefail
: "${MEASURE_HOST:?set MEASURE_HOST}"
d="/etc/letsencrypt/live/$MEASURE_HOST"
install -d "$d"
openssl req -x509 -nodes -newkey rsa:2048 -days 90 -subj "/CN=$MEASURE_HOST" \
  -addext "subjectAltName=DNS:$MEASURE_HOST" -keyout "$d/privkey.pem" -out "$d/fullchain.pem"
echo "Self-signed certificate for $MEASURE_HOST in $d (browsers will warn; accept it for testing)."
