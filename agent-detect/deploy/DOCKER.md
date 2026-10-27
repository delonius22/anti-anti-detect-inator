# Running the demo in Docker

`compose.yaml` runs the demo as two containers: nginx (`nginx/demo.conf`, with TLS and rate limits) and the app. Only nginx publishes ports. Reports go to SQLite in the `reports` volume. About 15 minutes the first time.

This is for the demo only. The capture app can't run behind Docker's port publishing, because the TCP-level measurements would describe Docker instead of the visitor; use `DEPLOY.md` for it.

## What the containers are allowed to do

| | app | nginx |
| --- | --- | --- |
| Published ports | none | 80 and 443 (`HTTP_PORT`, `HTTPS_PORT`) |
| Runs as | `node` (uid 1000) | master as root, to bind ports; workers as `nginx` |
| Root filesystem | read-only; only the `/data` volume is writable | read-only; config is rendered into a tmpfs at start |
| Linux capabilities | none | only `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE` |
| Also | `no-new-privileges`, 256 MB, 128 processes | `no-new-privileges`, 128 MB, 128 processes |

The app trusts `X-Forwarded-*` only from nginx's fixed address (`172.28.0.10`). The app needs outgoing HTTPS to fetch signing agents' keys.

## Go live on a server

### 1. Get a server and a domain name

- **Server:** any VPS with a public IPv4 address, such as Hetzner, DigitalOcean, Vultr, Linode or AWS Lightsail. The smallest plan is enough. These steps use Ubuntu 24.04.
- **Domain:** a name you control, for example `demo.example.com`. Every step below uses that name; substitute yours.
- **Don't** put a load balancer, CDN or "proxy" mode in front for now. If you add one later, see step 10.

### 2. Point the name at the server

At your DNS host, add `A  demo  <server IPv4>`. On Cloudflare, set the record to **DNS only** (grey cloud). Wait until this prints the server's IP from your own computer:

```bash
dig +short demo.example.com A
```

### 3. Lock down the server

Log in with SSH and keep the system patched:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades git
sudo ufw allow OpenSSH && sudo ufw enable
```

You don't need `ufw` rules for 80 and 443. Docker opens the ports it publishes itself, ahead of ufw's rules. That's also why `compose.yaml` publishes nothing except nginx's two ports. Never add a `ports:` entry to the `app` service.

If your provider has a cloud firewall, allow 22, 80 and 443 there.

### 4. Install Docker

```bash
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
sudo usermod -aG docker $USER   # then log out and back in
docker compose version          # must work without sudo
```

### 5. Copy the code and set the name

```bash
git clone <your repo URL> ~/agent-demo     # or scp a copy of agent-detect/ to the server
cd ~/agent-demo/agent-detect
cp .env.example .env
nano .env    # DEMO_HOST=demo.example.com; keep HTTP_PORT=80 and HTTPS_PORT=443
```

### 6. Start it

```bash
docker compose up -d --build
docker compose ps        # app "healthy", nginx "Up"
```

nginx starts with a self-signed certificate, so `https://demo.example.com` works but shows a browser warning. Step 7 replaces it.

### 7. Get a real certificate (Let's Encrypt)

```bash
docker compose --profile letsencrypt run --rm --entrypoint certbot certbot \
  certonly --webroot -w /var/www/acme -d demo.example.com \
  --email you@example.com --agree-tos --no-eff-email
docker compose restart nginx
docker compose logs nginx | grep agent-demo   # "using the Let's Encrypt certificate"
```

### 8. Turn on renewals

```bash
docker compose --profile letsencrypt up -d certbot
docker compose --profile letsencrypt run --rm --entrypoint certbot certbot renew --dry-run
```

The certbot container checks twice a day. nginx reloads every 12 hours to pick up a renewed certificate.

### 9. Check it from another device

Open `https://demo.example.com` on your phone (on mobile data, not your Wi-Fi) or another computer. The page should be blank, with a padlock and no warning. Wait about 10 seconds, then on the server:

```bash
docker compose exec app node -e 'const { DatabaseSync } = require("node:sqlite");
  const rows = new DatabaseSync("/data/demo.db", { readOnly: true })
    .prepare("SELECT id, created_at, ip, verdict FROM reports ORDER BY id DESC LIMIT 5").all();
  console.table(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })))'
```

The newest row should show the device's public IP and `no-evidence`. Then, from your own computer:

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} ' -X POST \
  -H 'content-type: application/json' -d '{}' https://demo.example.com/__agent/report; done; echo
# six 204s, then 429s (adds six empty rows)
curl -s --max-time 5 http://demo.example.com:3000/ || echo "OK: app port not reachable"
```

### 10. Before real visitors use it

- **Privacy notice:** each report stores the visitor's IP address and browser details. Publish a notice, and set `DEMO_RETENTION_DAYS` in `.env` to match it (default 90), then `docker compose up -d`.
- **Backups:** `deploy/backup-demo.sh` makes a checked copy of the database while the app runs. It writes `~/agent-demo-backups/demo-YYYY-MM-DD.db`, readable only by you, and keeps the newest 8. Run it once by hand, then schedule it weekly with `crontab -e`:
  ```
  15 3 * * 0 $HOME/agent-demo/agent-detect/deploy/backup-demo.sh >> $HOME/agent-demo-backups/backup.log 2>&1
  ```
  Copies on the server don't survive losing the server, so pull them to your own computer weekly too. Add this to your computer's `crontab -e`, an hour after the server's backup:
  ```
  15 4 * * 0 rsync -a deploy@demo.example.com:agent-demo-backups/ $HOME/agent-demo-backups/
  ```
  To restore a copy, stop the app, then replace `demo.db` and remove its old `-wal`/`-shm` files. Left in place, those would be replayed onto the restored copy. The one-off container runs as the app's user, so the file gets the right owner:
  ```bash
  docker compose stop app
  docker compose run --rm --no-deps -T -v "$HOME/agent-demo-backups/demo-YYYY-MM-DD.db:/restore.db:ro" app \
    sh -c 'cp /restore.db /data/demo.db && rm -f /data/demo.db-wal /data/demo.db-shm'
  docker compose start app
  ```
- **Known agents:** any agent that signs with Web Bot Auth comes back as `verified-agent`. Add the ones you trust to `KNOWN_SIGNERS` in `server/identify-agent.js`, then rebuild.
- **One app container:** replayed signatures are tracked in memory. Don't scale `app` past 1 without moving that cache to Redis.
- **Signed agents need port 443:** signatures cover the host name the agent used. On a non-standard port (like the local `8443`), signed requests fail the host check.
- **CDN later:** if you put one in front, change `TRUST_PROXY` in `compose.yaml` to the CDN's address ranges as well as nginx's, and set nginx's `real_ip` to match. Otherwise every visitor shows the CDN's IP.

## Updating

```bash
cd ~/agent-demo/agent-detect
git pull
docker compose up -d --build
docker image prune -f
```

The `reports`, `letsencrypt` and `selfsigned` volumes survive rebuilds. `docker compose down` keeps them too. Only `docker compose down -v` deletes them, along with every report.

## Try it on your own network first (optional)

1. Set `DEMO_HOST` in `.env` to your computer's LAN address (`hostname -I` on Linux), with `HTTP_PORT=8080` and `HTTPS_PORT=8443`.
2. Run `docker compose up -d --build`.
3. Open `https://<that address>:8443` from a phone on the same Wi-Fi and accept the certificate warning.

Docker Desktop (macOS and Windows) relays published ports through its own proxy. There, every visitor shows Docker's address, and all visitors share one rate limit. On a Linux server, nginx sees real addresses.

## Logs and troubleshooting

- `docker compose logs -f app` and `docker compose logs -f nginx`
- `docker compose ps` shows health

| Symptom | Likely cause |
| --- | --- |
| `set DEMO_HOST in .env` | `.env` is missing or has no `DEMO_HOST` (step 5) |
| nginx keeps restarting | `docker compose logs nginx`; an `agent-demo:` line says what's wrong |
| certbot: `Connection refused` or `Timeout during connect` | DNS doesn't point at this server yet, or port 80 is blocked by a cloud firewall |
| certbot succeeded but the browser still warns | `docker compose restart nginx` (step 7) |
| `502 Bad Gateway` | App unhealthy: `docker compose logs app` |
| Every row has `ip` `172.28.0.1` | Traffic is arriving through Docker's proxy rather than straight in (Docker Desktop, or IPv6 to the host) |
| Signed agents are `claimed-agent` with a host error | The server isn't on port 443, or something in front changed the `Host` header |
| `Pool overlaps with other one on this host` | Another Docker network uses `172.28.0.0/24`; change the subnet and both fixed addresses in `compose.yaml` |
