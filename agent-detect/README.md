# The Anti-Anti-Detect-inator

*Behold! No robot shall browse my website wearing the face of a human ever again!*

Identifies ChatGPT's cloud browser (agent / ChatGPT Work / dots) and flags other automated browsers.

## Why this needs a server

Page JavaScript cannot read the headers of the request that loaded the page. ChatGPT proves who it is with the
`Signature`, `Signature-Input` and `Signature-Agent` headers (Web Bot Auth, RFC 9421). Its User-Agent is ordinary Chrome.
The server checks the signature and the page asks it for the result through `GET /__agent`. ChatGPT's cloud browser
signs its fetch requests too, so the server re-checks the signature on that call.

## Measurement host (capture app)

`server/capture-app.js` is the redirect/stop-page app from the test plan. It runs on its own hostname, directly behind the patched nginx in `nginx/`, with no CDN in front. It stores allowlisted short links, server and page fingerprints, 10 in-page RTT samples, the T0–T5 timeline and a verdict per visit in SQLite. Test locally with `deploy/LOCAL.md` (`npm run dev` for app-only, or the full stack in an Ubuntu VM), then deploy with `deploy/DEPLOY.md`.

## Files

| File | Role |
|---|---|
| `server/identify-agent.js` | `identifyAgent(request)` → `verified-agent` / `claimed-agent` / `none`. Runtime-neutral (Fetch `Request`). |
| `server/express-adapter.js` | `req.agent` on every request, plus `GET /__agent`. |
| `client/agent-detect.js` | `detectAgent()` → server verdict + in-page heuristics + behaviour scoring. |
| `server/demo.js` | Working example. `npm run demo`, then open http://localhost:3000 |
| `server/capture-app.js`, `store.js`, `scoring.js` | Measurement app, SQLite store, verdict scoring. |
| `client/stop.js` | Stop-page checks J1–J12, probe flags C1–C12 and F1, the Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-Ping-inator echo (H3), Continue behaviour. |
| `client/probes.js`, `vendor/creepjs/` | Page probes based on CreepJS (MIT): lies, headless/stealth, worker scope, resistance, component hashes, stable ID. Built bundle plus vendored source and patches. FingerprintJS v5 (MIT) is served from `node_modules`. Coverage and test results: `docs/PROBES.md`. |
| `nginx/` | `measure.conf`, `fp-headers.conf`, and the `syn-ttl-module` that exposes `$syn_ttl` / `$syn_hops`. |
| `server/geo.js`, `hosting-asns.js` | IP lookup: MaxMind GeoLite2 first, DB-IP Lite fallback; hosting-network heuristic (N3, X4, J12, H5). |
| `server/model.js` | System 1 model at run time: human / agent / anti-detect percentages from `model.json` (`MODEL_FILE`, optional `MODEL_PRIORS`). |
| `docs/TEST-PLAN.md` | The test plan, with an appendix mapping every test ID to the code. |
| `docs/MATH.md` | Every formula in one place: hop timing, speed-of-light floor, scores and fitted weights, the model's percentages and calibration, entropy, surprisal and impossible pairs. |
| `server/declared-bots.js` | Bot user-agent tokens checked against operator-published IP lists (N2). |
| `scripts/` | `update-bot-ips.js` (N2 lists), `export-visits.js` (CSV/JSONL export + per-cohort flag rates). |
| `deploy/` | `LOCAL.md`, `DEPLOY.md`, `build-nginx.sh`, `selfsigned-cert.sh`, `update-geoip.sh`, systemd units and weekly timer, env template. |
| `analysis/` | Python Phase 6 toolkit: signal grading, weight fitting, the System 1 model (trains `model.json`), P1–P5 (device-ID linkage, rarity, impossible combinations), exit criteria report (`analysis/README.md`). |
| `test/` | `npm test` (signatures), `npm run test:probes` (probe bundle and C12), `npm run test:geo` (needs `GEO_TEST_DIR`), `npm run test:capture` (needs `NGINX_BIN`), `npm run test:model` (Node vs Python parity), `npm run e2e`. |

## Rules

- Make access decisions only with `req.agent` on the server. A client can fake or strip anything `detectAgent()` reports.
- `claimed-agent` means the request had signature headers that failed the check. Treat it as spoofed, not as ChatGPT.
- `no-evidence` does not prove a human is there.
- Behind a CDN or proxy, the request URL must carry the public host. The signature covers `@authority`, so a rewritten host fails the check.
- If you run more than one instance, move the nonce cache in `identify-agent.js` to Redis.
- Before you ship, test with a real dot: have it open `/__agent` on a staging URL and confirm the response is `verified-agent`.

## Credits

The page probes are based on [CreepJS](https://github.com/abrahamjuliot/creepjs) by Abraham Juliot (MIT; notice in `vendor/creepjs/LICENSE` and the bundle banner). Device IDs use [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs) (MIT). Neither project endorses this one.
