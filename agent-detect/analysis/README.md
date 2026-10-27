# Phase 6 analysis (Python)

Reads the capture app's `visits.db` and answers the test plan's Phase 6 questions:

| Question | Module | Output |
|---|---|---|
| How good is each signal? | `grading.py` | Strong / supporting / dropped per flag, graded on its best-caught tool vs C1 and C2 |
| What weights should the scorer use? | `fit.py` | Logistic regression on earlier runs, tested on later runs, turned into integer weights and a threshold |
| Which visits are one machine with many identities? (P1) | `population.py` | Clusters with identical stable values (JA4T, TTL, GPU, fonts, network, CPU count) but different user-agents, canvas hashes or JA4s |
| Who is hitting hard? (P2) | `population.py` | Busiest hours per JA4 and per network |
| What gives each tool away? (P3) | `population.py` | Values in at least 80% of one tool's visits and at most 1% of everyone else's |
| What should RTT_GAP_MS be? | `thresholds.py` | 99th percentile of C1 and C2 gaps, plus per-cohort distributions |
| Are we done testing? | `exit_criteria.py` | The plan's five exit criteria, each PASS / FAIL / NOT YET |
| What are the odds this visit is human, agent or anti-detect? | `model.py` | The System 1 model: calibrated percentages and reasons per visit (`tags.csv`), plus `model.json` for live scoring in Node |

The Node app keeps capturing. This only reads its data.

## Install

Python 3.10 or newer:

```bash
cd analysis
python3 -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ".[test]"
```

## Run

Try it first on synthetic data (invented rates, the same format as the real app):

```bash
python -m inator_analysis demo-data --out demo.db
python -m inator_analysis report --db demo.db --out demo-report
```

On real data, copy the database off the server, then run the report:

```bash
scp you@SERVER:/var/lib/capture-app/visits.db .
python -m inator_analysis report --db visits.db --out phase6
```

Open `phase6/report.md`. The folder also holds:
- `signal_grades.csv`, `flag_rates_by_cohort.csv`, `device_linkage.csv`, `id_linkage.csv`, `tool_traces.csv`, `exit_criteria.csv`
- `attribute_entropy.csv`, `rarity_by_visit.csv` (P4 rarity and P5 impossible combinations; also merged into `tags.csv`)
- `weights.json` (fitted weights and thresholds)
- `model.json`, `parity.json`, `tags.csv` (the System 1 model, its Node parity cases, and per-visit percentages)
- `signal_grades.png`, `rtt_gap.png`

`example-report/` shows the output on the demo data.

Options: `--precision 0.98` (the target used to pick thresholds), `--min-n 30` (visits needed before a rate is trusted), `--allow-negative` (keep negative weights; not recommended, see below). The report also reads `visits.jsonl` from `scripts/export-visits.js`.

## How to label runs so this works

Every short link carries `cohort` and `tool`. Use the plan's codes as the first word of `cohort` (`C1` people, `C2` privacy browsers, `C3` cloud agents, `C4` local agents, `C5` server fetchers, `C6` anti-detect browsers). Keep `tool` consistent: `playwright-headless` on every run, not sometimes `pw-headless`. Grading, fitting and P3 all group by these two fields.

## Design decisions worth knowing

- **Graded on the best-caught tool.** A signal is usually built for one kind of tool: webdriver catches Playwright, not Comet. Pooling every target cohort would bury it, so the grade uses the best-caught tool that has at least `--min-n` visits. The pooled rate is still shown.
- **Hold-out by run date.** The earlier 70% of run dates fit the model; the later 30% test it. No run is in both halves, and the test also shows drift. With only one run date, it falls back to holding out whole links.
- **No negative weights by default.** A flag that fires more on people than on targets gets a negative coefficient. As a weight, it would let an attacker lower their own score by triggering that flag on purpose, for example by using a datacenter IP. Those flags are clamped to 0 and listed as candidates to drop.
- **Rarity is measured against people, leave-one-out.** Each attribute's entropy and each visit's surprisal (mean -log2 P(value), the AmIUnique measure) use only C1 and C2 as the reference, and a visit never counts toward its own probability. CreepJS component hashes become `h:<component>` columns for this. Identifiers built to be unique per device (CreepJS stable ID, FingerprintJS ID, JA4H) are left out, or every visit would look maximally rare. Attributes are added as if independent, which overstates totals; read the mean and the percentile against people.
- **"Impossible" means "never seen together among people".** A pair of coarse values (UA OS with GPU family, TTL, font set, JA4T, worker platform, core count; timezone with country...) is flagged only when each value appears among at least 3 people on its own. Rare real setups, such as a Windows VM on a Mac, show up until the reference set includes them.
- **Linkage is a lead, not a verdict.** Two people with the same laptop model on the same ISP can share every stable value. Clusters are ranked by how many identities they claim, so anti-detect profiles rise to the top, but inspect them before acting.

## The System 1 model

A fast, calibrated classifier: every visit gets a percentage for **human**, **agent** and **anti-detect**, a tag, and the three signals that pushed it there.

- **Two models, compared on held-out runs.** Multinomial logistic regression with temperature scaling, which is exported to Node, and calibrated gradient-boosted trees, used for Python batch tagging only. `tags.csv` uses whichever had lower held-out log loss. The report prints both, plus a reliability table: when the model said about 90%, how often it was right.
- **Inputs:** every flag, plus JavaScript ran, clicked, hosting network, round-trip gap, TCP round-trip time, SYN hops, pointer moves, click offset, and from the probes: probes ran, CreepJS lie count, headless rating and stealth rating. Rarity scores are not model inputs yet, because Node would need the reference counts; they are in `tags.csv` beside the percentages. Missing numbers get their own indicator, so "no ping data" is evidence too.
- **A verified Web Bot Auth signature always wins the tag.** Percentages never override proof.
- **Percentages reflect the cohort mix you tested with.** Your lab runs might be one third anti-detect; real traffic isn't. Pass `--priors human=0.97,agent=0.02,antidetect=0.01` (or set `MODEL_PRIORS` in Node) to shift them to the mix you expect live.
- **Live in Node:** copy `model.json` to the server, set `MODEL_FILE=/var/lib/capture-app/model.json` in `/etc/capture-app.env` and restart. Each verdict gains `model.probabilities`, `model.tag` and `model.reasons`. `npm run test:model` (with `MODEL_DIR` set to your report folder) proves Node reproduces Python's numbers.
- **Retrain after every round of test runs.** The model only knows the tools and versions in your labeled data.

## Applying the results

`report.md` lists the fitted weights and thresholds. Copy each weight into the `w:` of that flag in `client/stop.js` (page checks) or `server/scoring.js` (server checks). Then set `THRESHOLDS.suspectedAgent` and `THRESHOLDS.antiDetect`, and `RTT_GAP_MS` in `/etc/capture-app.env`. Re-run the report after the next round of test runs to confirm the change.

## Tests

```bash
python -m pytest -q tests
NODE_VISITS_DB=/path/to/visits.db python -m pytest -q tests   # also checks a real capture-app database
```
