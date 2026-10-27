# Vendored CreepJS

Source: https://github.com/abrahamjuliot/creepjs, commit `10aa6724cd33a1015db1574211890518cd04f0cc` (Jun 11, 2026).
License: MIT, Copyright (c) Abraham Juliot. See `LICENSE`. The name "CreepJS" is used here only to describe where the
code came from, as `TRADEMARKS.md` allows; this project is not CreepJS and is not endorsed by its author.

`src/` is upstream code. Changes, each marked `[inator patch]` in the source:

| File | Change | Why |
| --- | --- | --- |
| `src/worker/index.ts` | `scriptSource` is `/probes.js` | The capture app serves the bundle there. A service worker's default scope is its script's directory, and `navigator.serviceWorker.ready` only resolves when that scope covers the page (`/r/...`) |
| `src/worker/index.ts` | location check accepts `^/probes.js$` | Otherwise every visit reports a lied worker scope |
| `src/status/index.ts` | `getScriptSize()` returns `null` | It re-downloaded the script to measure it |

Added: `src/inator-entry.ts` (collectors and hashing copied from `src/creep.ts`, rendering and logging removed, summary
exposed as `globalThis.__INATOR_PROBES`), `rollup.config.js`, `tsconfig.build.json`, `package.json` (build tools only).
Not used: `src/samples`, `src/prediction`, the WebRTC ICE collector, every `*HTML` renderer.

To update: copy a newer upstream `src/` over this one, re-apply the three patches (`grep -rn "inator patch" src`),
diff upstream `src/creep.ts` against the copied section of `src/inator-entry.ts`, then `npm run build:probes` at the
project root and run `node test/probes.test.js` and `npm run test:capture`.
