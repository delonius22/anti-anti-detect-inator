"""Command line:

    python -m inator_analysis report  --db /var/lib/capture-app/visits.db --out phase6/
    python -m inator_analysis report  --db visits.jsonl --out phase6/
    python -m inator_analysis demo-data --out demo.db
"""
from __future__ import annotations

import argparse
import sys

from .demo import make_demo_db
from .report import build_report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="inator_analysis", description="Phase 6 analysis for the Anti-Anti-Detect-inator")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("report", help="build report.md, CSVs, charts and weights.json")
    r.add_argument("--db", required=True, help="visits.db from the capture app, or visits.jsonl from export-visits.js")
    r.add_argument("--out", default="phase6-report", help="output folder")
    r.add_argument("--precision", type=float, default=0.98, help="precision target for thresholds (default 0.98)")
    r.add_argument("--min-n", type=int, default=30, help="visits needed before a rate is trusted (default 30)")
    r.add_argument("--allow-negative", action="store_true", help="keep negative weights (not recommended)")
    r.add_argument("--priors", default=None,
                   help='expected live mix for tags.csv, e.g. "human=0.97,agent=0.02,antidetect=0.01"')

    d = sub.add_parser("demo-data", help="write a synthetic visits.db in the capture app's format")
    d.add_argument("--out", default="demo.db")
    d.add_argument("--per-tool", type=int, default=40)
    d.add_argument("--seed", type=int, default=1)

    a = p.parse_args(argv)
    if a.cmd == "report":
        priors = None
        if a.priors:
            priors = {k.strip(): float(v) for k, v in (p.split("=") for p in a.priors.split(","))}
        path = build_report(a.db, a.out, precision_target=a.precision, min_n=a.min_n,
                            allow_negative=a.allow_negative, priors=priors)
        print(f"Report written to {path}")
    else:
        path = make_demo_db(a.out, per_tool=a.per_tool, seed=a.seed)
        print(f"Synthetic visits written to {path} (invented rates; for trying the toolkit only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
