# Deploying the demo

The demo (`server/demo.js`) runs detection in the visitor's browser, shows nothing, and saves each visit's report to SQLite on the server. It runs behind stock nginx (`nginx/demo.conf`), which adds TLS and rate limits. About 20 minutes the first time.

This is not the measurement host. For the capture app, with JA4, TTL and TCP round-trip time, follow `DEPLOY.md` instead.

## 1. Server, DNS and firewall

- **OS:** Ubuntu 24.04 LTS. Its nginx 1.24 works with `nginx/demo.conf` as shipped.
- **Size:** the smallest plan any provider sells is enough.
- **DNS:** add `A  demo  <server IPv4>` (and `AAAA` if you have IPv6). Every step below uses `demo.example.com`; substitute yours.

Open only SSH, 80 and 443. The app listens on `127.0.0.1:3000`, so port 3000 stays closed. The server must be able to make outgoing HTTPS requests: it fetches each signing agent's public keys (ufw allows outgoing traffic by default).

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Install Node, nginx and the code

Node 22.13 or newer is required for the built-in SQLite store.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs nginx certbot
node -v    # must print v22.13 or later

sudo useradd --system --home /opt/agent-demo --shell /usr/sbin/nologin agentdemo
sudo mkdir -p /opt/agent-demo
sudo cp -r agent-detect/. /opt/agent-demo/      # or git clone / unzip into /opt/agent-demo
cd /opt/agent-demo && sudo npm ci --omit=dev
sudo install -d -o agentdemo -g agentdemo /var/lib/agent-demo
```

## 3. Start the app

```bash
sudo install -m 644 deploy/agent-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-demo
systemctl status agent-demo     # "active (running)"; the log line says demo on http://127.0.0.1:3000
```

Settings live in the unit file. To change one without editing it, put `NAME=value` lines in `/etc/agent-demo.env` and run `sudo systemctl restart agent-demo`.

| Variable | Default in the unit | Meaning |
| --- | --- | --- |
| `DEMO_DB_PATH` | `/var/lib/agent-demo/demo.db` | Where reports are stored |
| `DEMO_RETENTION_DAYS` | `90` | Reports older than this are deleted, at startup and hourly. Empty or `0` keeps everything |
| `TRUST_PROXY` | `loopback` | Addresses allowed to send `X-Forwarded-*`. Leave it while nginx is on the same server |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Keep `HOST` on loopback, or visitors can skip nginx and its rate limits |
| `NODE_ENV` | `production` | Stops Express from sending stack traces |

## 4. Get the TLS certificate

`demo.conf` points at the certificate files, so nginx won't load it until they exist. Get the first certificate with nginx stopped, so port 80 is free:

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d demo.example.com \
  --agree-tos -m you@example.com --non-interactive
```

## 5. Turn on the nginx site

```bash
sudo mkdir -p /var/www/acme
sudo cp nginx/demo.conf /etc/nginx/sites-available/agent-demo
sudo sed -i 's/DEMO_HOST/demo.example.com/g' /etc/nginx/sites-available/agent-demo
sudo ln -s /etc/nginx/sites-available/agent-demo /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl start nginx
```

**No IPv6 on the server?** Delete the two `listen [::]:...` lines from `/etc/nginx/sites-available/agent-demo`. Otherwise nginx fails with `Address family not supported`.

Then switch renewals to the webroot method, so they work while nginx holds port 80:

```bash
sudo certbot certonly --webroot -w /var/www/acme -d demo.example.com \
  --deploy-hook "systemctl reload nginx" --force-renewal --non-interactive
sudo certbot renew --dry-run
```

## 6. Check it

Open `https://demo.example.com` from your own computer, not the server. The page is blank by design. Wait about 10 seconds, then on the server:

```bash
sudo -u agentdemo node -e 'const { DatabaseSync } = require("node:sqlite");
  const rows = new DatabaseSync(process.argv[1], { readOnly: true })
    .prepare("SELECT id, created_at, ip, verdict FROM reports ORDER BY id DESC LIMIT 5").all();
  console.table(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })))' \
  /var/lib/agent-demo/demo.db
```

| Field | Healthy value | If not |
| --- | --- | --- |
| `ip` | Your own public IP | `127.0.0.1` or `::1`: `TRUST_PROXY` is wrong, or nginx isn't setting `X-Forwarded-For` |
| `verdict` | `no-evidence` from a normal browser | No row at all: see the troubleshooting table |

Check the rate limit and that port 3000 is closed, from your computer:

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} ' -X POST \
  -H 'content-type: application/json' -d '{}' https://demo.example.com/__agent/report; done; echo
# expect six 204s, then 429s
curl -s --max-time 5 http://demo.example.com:3000/ || echo "OK: port 3000 not reachable"
```

The first command adds six empty rows to `reports`; they're harmless.

## 7. Before real visitors use it

- **Privacy notice:** every report stores the visitor's IP address and browser details. Add a notice, and set `DEMO_RETENTION_DAYS` to what your notice promises.
- **Backups:** copy `/var/lib/agent-demo/demo.db` off the server on a schedule. With the app running, use SQLite's backup (`sudo apt-get install -y sqlite3`, then `sqlite3 /var/lib/agent-demo/demo.db ".backup /tmp/demo-copy.db"`), not a plain `cp`, which can catch the database mid-write.
- **One instance:** replayed signatures are tracked in memory, so run one copy of the app. More than one needs the nonce cache in `server/identify-agent.js` moved to Redis.
- **Known agents:** any agent that signs with Web Bot Auth comes back as `verified-agent`. Add the ones you trust to `KNOWN_SIGNERS` in `server/identify-agent.js`, and base decisions on `known`.
- **CDN:** if you ever put one in front, set `TRUST_PROXY` to its address ranges. Otherwise every visitor shows up with the CDN's IP, and signatures fail the host check.

## Updating

```bash
cd /opt/agent-demo
sudo cp -r /path/to/new/agent-detect/. .   # or git pull
sudo npm ci --omit=dev
sudo systemctl restart agent-demo
```

If `nginx/demo.conf` changed, repeat the `cp` and `sed` from step 5, then `sudo nginx -t && sudo systemctl reload nginx`.

## Logs and troubleshooting

- App: `journalctl -u agent-demo -f`
- nginx: `/var/log/nginx/error.log` and `/var/log/nginx/access.log`

| Symptom | Likely cause |
| --- | --- |
| `502 Bad Gateway` | The app isn't running: `systemctl status agent-demo` and `journalctl -u agent-demo` |
| App exits with `unable to open database file` | `/var/lib/agent-demo` is missing or not owned by `agentdemo` (step 2) |
| Page loads but no rows appear | The browser left within the 8-second detection window, or the report got a `429`; check the nginx access log for `/__agent/report` |
| Every row has `ip` `127.0.0.1` | `TRUST_PROXY` doesn't include nginx's address, or the request bypassed nginx |
| `nginx -t` fails: `cannot load certificate` | Step 4 hasn't run, or the domain in the site file doesn't match the certificate |
| `nginx -t` fails: `unknown directive "http2"` | The site file is an old copy; copy `nginx/demo.conf` again |
| Signed agents come back `claimed-agent` with `too many key lookups` | More than 30 new signers in a minute; it clears after a minute |
| Signed agents come back `claimed-agent` with a host or authority error | A proxy changed the `Host` header; the signature covers it |
