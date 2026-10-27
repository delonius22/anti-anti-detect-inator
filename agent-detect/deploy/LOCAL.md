# Testing locally

Two ways, in this order. Path A takes five minutes on any computer and checks the app itself. Path B runs the full stack, nginx included, in an Ubuntu 24.04 virtual machine that matches the production server. Then go to `DEPLOY.md` for hosting.

Why not Docker? The patched nginx needs Linux, and on macOS and Windows, Docker Desktop forwards published ports through its own proxy. That proxy ends the browser's TCP connection, so JA4T, TTL and TCP round-trip time would describe Docker's proxy instead of your browser. That's the same reason the production host can't sit behind a CDN.

## Path A: app only, any OS (about 5 minutes)

Checks the stop page, every page check (J1 to J12), the WebSocket round-trip time, Continue behavior, the T0 to T5 timeline, storage, scoring and the export. JA4, JA4H, JA4T, TTL and TCP round-trip time stay empty, because nginx is what measures them.

1. Install Node.js 22.13 or newer from nodejs.org. Check with `node -v`.
2. Unzip `agent-detect.zip`, open a terminal in that folder, and run:

```bash
npm ci
npm run dev
```

3. In a second terminal, create a link. On macOS or Linux:

```bash
curl -s -X POST http://127.0.0.1:3000/api/links \
  -H "Authorization: Bearer dev-token" -H "content-type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","cohort":"C1","tool":"my-browser"}'
```

On Windows PowerShell:

```powershell
$h = @{ Authorization = "Bearer dev-token" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/links -Headers $h `
  -ContentType "application/json" `
  -Body '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","cohort":"C1","tool":"my-browser"}'
```

4. Open the `short` URL in your browser. Move the mouse, wait two or three seconds, and click Continue.
5. Read the visit back:

```bash
curl -s -H "Authorization: Bearer dev-token" "http://127.0.0.1:3000/api/visits?limit=1"
```

On PowerShell: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/visits?limit=1" -Headers $h | ConvertTo-Json -Depth 8`

**What to look for:** `rtt.samplesMs` has 10 values, `t0` to `t5` are all set, and `client.raw` holds the WebGL, font, worker and canvas results. Your own browser should get `suspectedAgent: false`.

Then try a different browser, a private window, or a headless one, and compare. Data lives in `dev-data/`; delete that folder to start over.

**Two quirks of dev mode:**
- `viaNginx` shows `true`. The app trusts requests from your own machine because in production only nginx can reach it. There is no nginx here, so the fingerprint fields are simply empty.
- Geo fields are empty because `127.0.0.1` is a private address. IP lookup only works for public IPs, which means on a real server.

## Path B: full stack in an Ubuntu VM (about 30 minutes)

This is the same Ubuntu 24.04 setup as production, so it also rehearses `DEPLOY.md`. Multipass runs on macOS, Windows and Linux.

1. Install Multipass from multipass.run, then create and enter the VM:

```bash
multipass launch 24.04 --name measure --cpus 2 --memory 2G --disk 10G
multipass transfer agent-detect.zip measure:/home/ubuntu/
multipass shell measure
```

2. Inside the VM, unzip and build nginx with a local name and a self-signed certificate:

```bash
sudo apt-get update && sudo apt-get install -y unzip
sudo mkdir -p /opt/capture-app && sudo unzip -q ~/agent-detect.zip -d /opt/capture-app
cd /opt/capture-app/deploy
sudo MEASURE_HOST=measure.test ./build-nginx.sh
sudo MEASURE_HOST=measure.test ./selfsigned-cert.sh
sudo systemctl enable --now nginx-measure
```

3. Install the app exactly as in `DEPLOY.md` step 7. Use `PUBLIC_ORIGIN=https://measure.test` in `/etc/capture-app.env`. Step 7b is optional here: the databases load fine, but they can't place your own machine's private VM address.

4. On your computer (not in the VM), find the VM's address and point `measure.test` at it:

```bash
multipass info measure | grep IPv4
```

Add a line like `192.168.64.5  measure.test` (with your VM's address) to your hosts file:
- macOS and Linux: `/etc/hosts`, edit with `sudo nano /etc/hosts`
- Windows: `C:\Windows\System32\drivers\etc\hosts`, open Notepad as administrator

5. Open `https://measure.test/api/whoami` in your browser and accept the certificate warning. You should see a `ja4` for your browser, plus `ja4t`, `synTtl`, `synHops` and `tcpRttUs` from your computer's TCP stack.

Then create a link (`DEPLOY.md` step 9, with `https://measure.test` and your token) and click through it as in Path A.

**WSL2 on Windows:** it works for building, but by default Windows reaches WSL through a relay that ends TCP connections. That would hide the TCP-level values just as Docker does, so use Multipass for Path B.

### Run the automated tests (in the VM)

```bash
cd /opt/capture-app
sudo npm ci                                  # includes Playwright for the browser tests
sudo npx playwright install --with-deps chromium
npm test                                     # Web Bot Auth signatures
npm run test:probes                          # probe bundle: attribution, no third-party calls, C12 checks

# Geo tests: MaxMind's public test databases + a DB-IP Lite city file
git clone --depth 1 https://github.com/maxmind/MaxMind-DB.git /tmp/mmdb
mkdir -p /tmp/geotest && cp /tmp/mmdb/test-data/GeoLite2-City-Test.mmdb /tmp/mmdb/test-data/GeoLite2-ASN-Test.mmdb /tmp/geotest/
(cd /tmp && npm pack dbip-city-lite && tar xzf dbip-city-lite-*.tgz && gunzip -c package/dbip-city-lite.mmdb.gz > /tmp/geotest/dbip-city-lite.mmdb)
GEO_TEST_DIR=/tmp/geotest npm run test:geo

# nginx + app + headless Chromium, end to end (uses ports 18080/18443/13000)
sudo NGINX_BIN=/opt/nginx-measure/sbin/nginx npm run test:capture
```

## What local testing cannot show

- **Real agents.** ChatGPT's cloud browser, dots, Browserbase and Perplexity can't reach your laptop or VM. Test them against the hosted server.
- **IP checks.** N2, N3, X4, J12 and H5 need visitors with public IP addresses.
- **Real network paths.** Between your computer and a local VM, TTL hops and round-trip times are near zero. Real values only appear across the internet.

When Path B works, go to `DEPLOY.md`. The steps are the same apart from real DNS, a Let's Encrypt certificate in place of `selfsigned-cert.sh`, and step 7b.
