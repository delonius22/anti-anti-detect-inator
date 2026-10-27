#!/usr/bin/env bash
# Builds nginx with FoxIO's JA4 module, the SYN capture patch and the
# syn-ttl module, installs it to /opt/nginx-measure, and installs the config.
# Tested on Ubuntu 24.04 (OpenSSL 3.0) with nginx 1.30.0 and the module
# commit pinned below. Run as root:  sudo MEASURE_HOST=m.example.com ./build-nginx.sh
set -euo pipefail

: "${MEASURE_HOST:?set MEASURE_HOST, e.g. m.example.com}"
NGINX_VERSION="${NGINX_VERSION:-1.30.0}"
JA4_COMMIT="${JA4_COMMIT:-99cc308c0b4d03a869fd196b729a6254b18996e1}"
PREFIX=/opt/nginx-measure
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"

apt-get update
apt-get install -y build-essential git patch libpcre2-dev zlib1g-dev libssl-dev

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
git clone -q https://github.com/FoxIO-LLC/ja4-nginx-module.git
git -C ja4-nginx-module checkout -q "$JA4_COMMIT"
git clone -q --depth 1 --branch "release-$NGINX_VERSION" https://github.com/nginx/nginx.git

cd nginx
patch -p1 < ../ja4-nginx-module/patches/nginx-tcp-save-syn.patch
patch -p1 < ../ja4-nginx-module/patches/nginx-ssl-save-client-hello.patch
auto/configure \
  --prefix="$PREFIX" \
  --conf-path=/etc/nginx-measure/nginx.conf \
  --error-log-path=/var/log/nginx-measure/error.log \
  --http-log-path=/var/log/nginx-measure/access.log \
  --pid-path=/run/nginx-measure.pid \
  --with-http_ssl_module --with-http_v2_module \
  --add-module=../ja4-nginx-module \
  --add-module="$REPO/nginx/syn-ttl-module"
make -j"$(nproc)"
make install

install -d /etc/nginx-measure /var/log/nginx-measure /var/www/acme
sed "s/MEASURE_HOST/$MEASURE_HOST/g" "$REPO/nginx/measure.conf" > /etc/nginx-measure/nginx.conf
if [ ! -s /proc/net/if_inet6 ]; then   # no IPv6 on this machine: drop the [::] listeners
  sed -i '/listen \[::\]/d' /etc/nginx-measure/nginx.conf
  echo "No IPv6 detected: removed the [::] listen lines."
fi
install -m 644 "$REPO/nginx/fp-headers.conf" /etc/nginx-measure/fp-headers.conf
install -m 644 "$HERE/nginx-measure.service" /etc/systemd/system/nginx-measure.service
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then systemctl daemon-reload; fi
"$PREFIX/sbin/nginx" -V
echo "Built. Get the TLS certificate (DEPLOY.md step 6) before starting nginx-measure."
