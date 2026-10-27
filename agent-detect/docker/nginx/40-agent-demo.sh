#!/bin/sh
# Run by the nginx image's entrypoint before nginx starts. Renders nginx/demo.conf for
# this container: host name, app address, certificate, and IPv6 only if the container has it.
set -eu

: "${DEMO_HOST:?set DEMO_HOST to the name or IP address visitors will use}"
: "${UPSTREAM:?set UPSTREAM to the app address, e.g. 172.28.0.20:3000}"
# Both end up inside nginx config and sed expressions, so allow only plain host/address characters.
case "$DEMO_HOST$UPSTREAM" in *[!A-Za-z0-9.:-]*) echo "agent-demo: DEMO_HOST or UPSTREAM has invalid characters" >&2; exit 1 ;; esac
# The host port visitors use for https (compose passes HTTPS_PORT), for the http -> https redirect.
PUBLIC_HTTPS_PORT=${PUBLIC_HTTPS_PORT:-443}
case "$PUBLIC_HTTPS_PORT" in ''|*[!0-9]*) echo "agent-demo: PUBLIC_HTTPS_PORT must be a number" >&2; exit 1 ;; esac

le_dir="/etc/letsencrypt/live/$DEMO_HOST"
self_dir=/etc/nginx/selfsigned
if [ -s "$le_dir/fullchain.pem" ] && [ -s "$le_dir/privkey.pem" ]; then
  cert_dir=$le_dir
  echo "agent-demo: using the Let's Encrypt certificate for $DEMO_HOST"
  # Pick up renewals from the certbot container.
  (while sleep 12h; do nginx -s reload; done) &
else
  cert_dir=$self_dir
  if [ "$(cat "$self_dir/host" 2>/dev/null)" != "$DEMO_HOST" ]; then
    case "$DEMO_HOST" in
      *:*) san="IP:$DEMO_HOST" ;;          # IPv6 address
      *[!0-9.]*) san="DNS:$DEMO_HOST" ;;   # host name
      *) san="IP:$DEMO_HOST" ;;            # IPv4 address
    esac
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$DEMO_HOST" -addext "subjectAltName=$san" \
      -keyout "$self_dir/privkey.pem" -out "$self_dir/fullchain.pem" 2>/dev/null
    chmod 600 "$self_dir/privkey.pem"
    echo "$DEMO_HOST" > "$self_dir/host"
  fi
  echo "agent-demo: using a self-signed certificate for $DEMO_HOST (browsers will warn)"
fi

conf=/etc/nginx/conf.d/agent-demo.conf
sed -e "s#/etc/letsencrypt/live/DEMO_HOST#$cert_dir#g" \
    -e "s/DEMO_HOST/$DEMO_HOST/g" \
    -e "s/server 127\.0\.0\.1:3000;/server $UPSTREAM;/" \
    /etc/agent-demo/demo.conf > "$conf"
if [ "$PUBLIC_HTTPS_PORT" != 443 ]; then
  sed -i "s#return 301 https://\$host\$request_uri;#return 301 https://\$host:$PUBLIC_HTTPS_PORT\$request_uri;#" "$conf"
fi
# Docker networks are IPv4-only unless IPv6 is turned on; nginx won't start on [::] without it.
if ! grep -qv '^00000000000000000000000000000001' /proc/net/if_inet6 2>/dev/null; then
  sed -i '/listen \[::\]/d' "$conf"
fi
