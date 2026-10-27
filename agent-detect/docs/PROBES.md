# Page probes: CreepJS coverage and FingerprintJS

The stop page loads three scripts, in this order:

| Path | What it is | Source |
| --- | --- | --- |
| `/probes.js` | CreepJS collectors, no rendering. Resolves `globalThis.__INATOR_PROBES` with a summary | `vendor/creepjs/` (based on CreepJS, MIT), built to `client/probes.js` |
| `/s/f.js` | FingerprintJS v5.3.0, open-source build | `node_modules/@fingerprintjs/fingerprintjs` (MIT) |
| `/s/stop.js` | Our checks J1–J12, B1–B3, the RTT echo, and the C/F flags built from the two above | `client/stop.js` |

`stop.js` sends its own checks first (`phase: "checks"`), then the probe results (`phase: "probes"`, usually 0.6–1 s after load). If the visitor clicks Continue before the probes finish, the page waits up to 2 s so the results are kept, then forwards.

## CreepJS coverage, module by module

Every collector CreepJS runs on its own page is included, except the three marked "no".

| CreepJS module | Included | Used for |
| --- | --- | --- |
| `worker` (service, shared, dedicated) | Yes | C4, C12, `hashes.workerScope` |
| `lies` (prototype lie detector) | Yes | C1, C11 |
| `headless` (headless, like-headless, stealth) | Yes | C2, C3, model numbers |
| `features` (CSS/JS/window feature versions) | Yes | C5, `hashes.features` |
| `resistance` (Brave, Firefox RFP, Tor, extensions) | Yes | C7 |
| `trash` | Yes | C8 |
| `errors` (captured errors) | Yes | count in summary |
| `webgl` (parameters, GPU confidence, pixels) | Yes | C9, `hashes.canvasWebgl*` |
| `canvas` (2D data, paint, text, emoji, text metrics) | Yes | C11, `hashes.canvas2d*` |
| `audio` (OfflineAudioContext) | Yes | C11, `hashes.offlineAudioContext` |
| `fonts` (FontFace load, platform version, apps) | Yes | summary, `hashes.fonts` |
| `timezone` (measured location) | Yes | C10, `hashes.timezone` |
| `navigator` (incl. high-entropy userAgentData) | Yes | summary, `hashes.navigator` |
| `screen`, `cssmedia`, `css` (computed and system styles) | Yes | hashes |
| `domrect`, `svg`, `math`, `engine` (console errors), `intl` | Yes | hashes |
| `window` (window features), `document` (HTML element version) | Yes | hashes |
| `media` (mime types), `speech` (voices) | Yes | hashes, voice count |
| `status` (memory, quota, network info, stack size, timer resolution, battery) | Yes, except the script-size download | summary |
| stable "creep" ID, fuzzy hash, bot hash | Yes | `verdict.ids`, C6, P1b |
| `webrtc` media device kinds | Yes | summary |
| `webrtc` ICE/STUN data | No: J11 already does this through your own `STUN_URL`, so the visitor is not sent to Google's STUN servers twice | J11 |
| `samples` (cloud fingerprint samples) | No: downloads a dataset from CreepJS's servers | |
| `prediction` (device guesses from samples) | No: needs `samples` | |

The summary keeps about 35 component hashes (`raw.creep.hashes`) instead of raw canvas and audio data, so a beacon stays near 5–15 KB (7 KB in testing). The Python toolkit turns 26 of them (the device-describing ones) into `h:<component>` columns for P4 rarity.

## Patches to CreepJS (`vendor/creepjs/PATCHES.md`)

1. Workers load `/probes.js`, not `./creep.js`. It sits at the site root because `navigator.serviceWorker.ready` only resolves for a registration whose scope covers the page; with the script under `/s/`, every visit waited 4 s for a timeout and fell back to a shared worker.
2. The worker's own-location check accepts `/probes.js`. Unpatched, every visit reported a lied worker scope.
3. The script-size check returns `null` instead of downloading the script again.

The entry file `src/inator-entry.ts` copies CreepJS's `creep.ts` collector and hashing code unchanged and replaces the rendering with the summary.

## FingerprintJS

`stop.js` calls `FingerprintJS.load({ monitoring: false })` and sets `window.__fpjs_d_m = true`. Without that, the npm build sends a request to `m1.openfpcdn.io` on 0.1% of page loads. It reads the visitor ID twice; a change inside one page load is F1. The ID goes into `verdict.ids.fpjs` and P1b. FingerprintJS's open-source ID is less stable than its paid service (its `confidence` score was 0.7 in testing); use it for linkage leads, not identity.

## What the tests showed (Chromium 153, Oct 27, 2026)

| Run | C/F flags | Notes |
| --- | --- | --- |
| Headless Playwright, default UA | C2-headless-traits (100%), C2-like-headless (94%), C8 | 0 lies |
| Headless, macOS UA set through Playwright | adds C1 (2 lies), C11, C12 worker-vs-page, C12 worker-vs-HTTP UA | CDP user-agent overrides do not reach the service worker |
| Init script patching `hardwareConcurrency` and `toDataURL` | C1 (`Navigator.hardwareConcurrency`, `HTMLCanvasElement.toDataURL`), C11, C12 | J5, J6, J8 also fired; F1 did not, because FingerprintJS leaves noisy canvas out of its ID |
| Headed Chromium, automation switches hidden, virtual display | C8 only (software GPU in the test machine); like-headless 56%, under the 70% threshold | Shows why the like-headless threshold is 70%, not 50% |
| No request to any other host | — | Checked in `test/capture.e2e.js` |

Two build findings worth knowing if you rebuild:

- **Do not minify with compression or name mangling.** Full terser minification produced about 400 false lies, a 20% stealth rating and a lied timezone on plain Chromium, because CreepJS inspects function source and names. The build strips whitespace only (`vendor/creepjs/rollup.config.js`).
- **CreepJS's feature-version tables stop near Chrome 115.** C5 can only catch an engine older than that claiming to be newer. J9 covers Chrome 97–128.

## The strongest argument against relying on these

CreepJS is public and popular, so commercial anti-detect browsers test against it. The better ones patch at the C++ level, where `toString` and prototype checks see nothing, and spoof the worker scope too. Expect C1–C12 to catch automation frameworks, extensions and script-injection spoofers, and to miss much of top-tier anti-detect traffic. That traffic is what the network layer (JA4T, TTL, H4 gap) and the population layer (P1b, P4, P5) are for, because a browser patch cannot change the machine's TCP stack or make a profile's values look like a real device's. Also, `/probes.js` is a fixed public URL; a tool can recognize it and behave differently on this page only.

False positives to measure in C2 runs: privacy extensions (CanvasBlocker, JShelter, Chameleon) create real lies and trip C1, C7 and C11 on people who are simply careful. Grade every C-series flag on C2 before trusting its weight.

## Rebuilding `client/probes.js`

```bash
npm run build:probes        # installs rollup + typescript under vendor/creepjs, then builds
node test/probes.test.js    # attribution present, no network calls, worker path correct
```

The built file is committed, so deploying does not need the build tools.
