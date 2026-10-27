# Deploying the measurement hostname

You will put the capture app on its own subdomain (for example `m.example.com`). That subdomain points straight at one server you control, with no CDN or proxy in front. Your main sites stay where they are. About 45 minutes the first time.

Why it must be direct: anything that ends the visitor's TCP or TLS connection before your server replaces JA4, JA4T, TTL and TCP round-trip time with its own values. The CDN lesson covers this in detail.

## 1. Pick the hostname

Use a subdomain you will not put behind a CDN later, such as `m.example.com` or `go.example.com`. Every step below uses `m.example.com`; substitute yours.

## 2. Rent a server

- **OS:** Ubuntu 24.04 LTS. The build script was tested on it.
- **Size:** 1 vCPU and 2 GB RAM. The app holds both IP databases in memory (DB-IP City Lite alone is about 130 MB) and takes a few seconds to start.
- **Network:** a public IPv4 address directly on the server. IPv6 is optional.
- **Providers that work:** any plain VPS, such as Hetzner, DigitalOcean, Vultr, Linode, or AWS Lightsail or EC2 with a public IP.
- **Do not** put a provider load balancer, "DDoS protection proxy" or web application firewall in front of it. Each one ends the TCP connection itself, which breaks the same measurements a CDN breaks.

## 3. Create the DNS record

At your DNS host, add `A  m  <server IPv4>`, and `AAAA  m  <server IPv6>` if you have IPv6.

- **Cloudflare DNS:** set the record's Proxy status to **DNS only** (grey cloud, not orange). Orange routes traffic through Cloudflare's CDN.
- **Other DNS hosts:** make sure no proxy, CDN or "web forwarding" feature is switched on for this record.

Check from your laptop. Both commands must print your server's IP, not someone else's:

```bash
dig +short m.example.com A
dig +short m.example.com AAAA
```

## 4. Open the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If your provider also has a cloud firewall, open 22, 80 and 443 there too. Port 3000 must stay closed: the app listens only on `127.0.0.1`.

## 5. Copy the code and build nginx

From your laptop:

```bash
scp agent-detect.zip you@SERVER_IP:/tmp/
```

On the server:

```bash
sudo apt-get update && sudo apt-get install -y unzip
sudo mkdir -p /opt/capture-app
sudo unzip -q /tmp/agent-detect.zip -d /opt/capture-app
cd /opt/capture-app/deploy
sudo MEASURE_HOST=m.example.com ./build-nginx.sh
```

The script installs build tools and pulls nginx 1.30.0 and FoxIO's JA4 module from GitHub, pinned to the tested commit. It applies the SYN and ClientHello patches, then builds nginx with both modules into `/opt/nginx-measure`. It also writes `/etc/nginx-measure/nginx.conf` and installs the `nginx-measure` service.

**No IPv6 on the server?** Delete the two `listen [::]:...` lines from `/etc/nginx-measure/nginx.conf`. Otherwise nginx fails with `Address family not supported`.

## 6. Get the TLS certificate

Port 80 must be free for this first request, so nginx is not running yet:

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d m.example.com \
  --agree-tos -m you@example.com --non-interactive
sudo systemctl enable --now nginx-measure
```

Then switch renewals to the webroot method, so they work while nginx holds port 80:

```bash
sudo certbot certonly --webroot -w /var/www/acme -d m.example.com \
  --deploy-hook "systemctl reload nginx-measure" --force-renewal --non-interactive
sudo certbot renew --dry-run
```

## 7. Install and start the app

Node 22.13 or newer is required for the built-in SQLite store.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs
node -v    # must print v22.13 or later

sudo useradd --system --home /opt/capture-app --shell /usr/sbin/nologin capture
sudo install -d -o capture -g capture /var/lib/capture-app
cd /opt/capture-app && sudo npm ci --omit=dev

sudo install -m 600 deploy/capture-app.env.example /etc/capture-app.env
openssl rand -hex 32          # paste this as ADMIN_TOKEN
sudo nano /etc/capture-app.env   # set ADMIN_TOKEN and PUBLIC_ORIGIN=https://m.example.com

sudo install -m 644 deploy/capture-app.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now capture-app
```

## 7b. Add the IP databases and bot IP lists

These power tests N2, N3, X4, J12 and H5. MaxMind GeoLite2 is checked first; DB-IP Lite fills in any IP that MaxMind lacks, and covers everything if you skip MaxMind.

1. **MaxMind (primary).** Create a free account at maxmind.com, accept the GeoLite2 license, and generate a license key. Note your account ID. Then:

```bash
sudo apt-get install -y geoipupdate
sudo tee /etc/GeoIP.conf >/dev/null <<'CONF'
AccountID YOUR_ACCOUNT_ID
LicenseKey YOUR_LICENSE_KEY
EditionIDs GeoLite2-City GeoLite2-ASN
CONF
sudo chmod 600 /etc/GeoIP.conf
```

If your Ubuntu release has no `geoipupdate` package, install the `.deb` from MaxMind's geoipupdate releases on GitHub.

2. **Download everything once.** DB-IP Lite needs no account.

```bash
sudo /opt/capture-app/deploy/update-geoip.sh
sudo runuser -u capture -- node /opt/capture-app/scripts/update-bot-ips.js
```

3. **Refresh weekly.**

```bash
cd /opt/capture-app
sudo install -m 644 deploy/capture-updates.service deploy/capture-updates.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now capture-updates.timer
```

4. **Tell the app where the server is (H5).** In `/etc/capture-app.env`, set `SERVER_PUBLIC_IP` to the server's IP, or set `SERVER_LAT` and `SERVER_LON`. Then:

```bash
sudo systemctl restart capture-app
curl -s -H "Authorization: Bearer $TOKEN" https://m.example.com/api/status | python3 -m json.tool
```

`geo` should list the loaded databases with their build dates, and `serverLocation` should not be `null`. The app re-reads updated database files within an hour, so weekly refreshes need no restart.

## 8. Verify that the server sees real network data

From your laptop at home, not from the server itself:

```bash
curl -s https://m.example.com/api/whoami | python3 -m json.tool
```

| Field | Healthy value | If not |
| --- | --- | --- |
| `viaNginx` | `true` | The app is being reached directly, so check the firewall on port 3000 |
| `ja4` | A string starting `t13` or `t12` | TLS is not ending at your nginx |
| `ja4t` | Four parts separated by `_`, for example window size, options, MSS, scale | `tcp_save_syn` is off, the SYN patch is missing, or something in front ends TCP |
| `synTtl` / `synHops` | TTL a little under 64 (macOS, Linux, phones) or 128 (Windows); hops above 0 | Hops of 0 from outside means a local proxy or NAT on the server |
| `tcpRttUs` | Several thousand microseconds or more from home | Very small values from far away mean a proxy is close to your server |
| `geo` | Your country and ISP's ASN; `citySource` `maxmind` or `dbip` | `null`: no databases loaded (step 7b) |

Then check that no CDN is answering:

```bash
curl -sI https://m.example.com/api/whoami | grep -iE 'cf-ray|via:|x-cache|x-served-by|akamai' \
  || echo "OK: no CDN headers"
```

## 9. Create a link and read the result

```bash
TOKEN=...   # your ADMIN_TOKEN
curl -s -X POST https://m.example.com/api/links \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=VIDEO_ID","cohort":"C1","tool":"chrome-mac","oneTime":true}'
```

Open the `short` URL it returns, click Continue, then read the visit:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://m.example.com/api/visits?limit=1" \
  | python3 -m json.tool | less
```

Each visit has `t0` to `t5`, the server fields, the page results, 10 RTT samples, and a `verdict` with its flags and hop summary (`tcpRttMs`, `pageRttMinMs`, `gapMs`, `synTtl`, `synHops`).

## 10. Before real visitors use it

- **Privacy notice:** add a notice and consent step where links are created, and link it from the stop page. The test plan's privacy row explains why.
- **Placeholders:** `RTT_GAP_MS` and the score thresholds in `server/scoring.js` are placeholders. Replace them after your C1 and C2 cohort runs.
- **STUN:** the WebRTC check (J11) makes the visitor's browser contact Google's STUN server. Set `STUN_URL=` (empty) to turn it off.
- **Probes:** `/probes.js` (based on CreepJS) and `/s/f.js` (FingerprintJS) are served by the app; nothing to build. The CreepJS service-worker probe needs a real HTTPS certificate (step 6), and `/probes.js` must stay at the site root. Do not name the site or its domain after CreepJS (its trademark policy). See `docs/PROBES.md`.
- **Backups:** copy `/var/lib/capture-app/visits.db` off the server on a schedule.
- **Data licenses:** DB-IP Lite is CC BY 4.0 and requires a visible "IP Geolocation by DB-IP" link to db-ip.com on any page that shows or uses its results. The admin API sends the credits in `/api/status` and the `X-Data-Attribution` header; any dashboard you build must show them. GeoLite2 use is governed by the MaxMind license you accept at signup: keep the weekly refresh running and do not redistribute the files.
- **Analysis:** copy `visits.db` off the server and run the Python toolkit in `analysis/` (`python -m inator_analysis report --db visits.db --out phase6`). It grades every signal, fits the weights, runs P1 to P5 (including rarity and impossible combinations) and checks the exit criteria. For a quick look on the server itself, `DB_PATH=/var/lib/capture-app/visits.db node scripts/export-visits.js /tmp/export` prints how often each flag fires per cohort.

## Logs and troubleshooting

- App: `journalctl -u capture-app -f`
- nginx errors: `/var/log/nginx-measure/error.log`
- Per-request fingerprints (JSON lines): `/var/log/nginx-measure/fingerprints.log`

| Symptom | Likely cause |
| --- | --- |
| `ja4t` and `synTtl` empty for some visits | The kernel used SYN cookies during a burst of connections; no SYN was saved |
| All fingerprint fields `null` | Request reached the app without nginx, or the `fp-headers.conf` include is missing |
| `cf-ray` header present | The DNS record is still proxied (orange cloud) |
| nginx fails on `[::]:80` | Server has no IPv6; remove the `listen [::]` lines |
| `geo` is `null` or `serverLocation` is `null` | Run step 7b; check `/api/status` and `journalctl -u capture-app` for "cannot open" |
| N2 always says `claimed` | Bot lists not downloaded yet; run `scripts/update-bot-ips.js` |
