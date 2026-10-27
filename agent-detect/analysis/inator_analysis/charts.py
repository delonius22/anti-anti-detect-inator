"""Two static charts for the Markdown report (PNG, light surface).

Palette: reference slots 1 (blue) and 2 (orange), validated as a pair
(CVD dE 24.7, normal-vision dE 33.6, both >= 3:1 on the surface).
Identity is never color-alone: both charts carry a legend or direct labels.
"""
from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

SURFACE = "#fcfcfb"; INK = "#0b0b0b"; INK2 = "#52514e"; GRID = "#e4e3df"; MUTED = "#a9a8a2"
BLUE = "#2a78d6"; ORANGE = "#eb6834"


def _style(ax):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=9, length=0)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def grading_chart(grades: pd.DataFrame, out: Path, max_rows: int = 30) -> Path | None:
    """Dot plot: for each flag, how often it fires on its best-caught tool (blue)
    versus the worse of C1 and C2 (orange). Good signals sit far right in blue and
    far left in orange; the dashed lines are the supporting (50%) and strong (90%) bars."""
    g = grades.dropna(subset=["best_tool_rate"]).head(max_rows).iloc[::-1]
    if g.empty:
        return None
    legit = g[["c1_rate", "c2_rate"]].max(axis=1).fillna(0)
    y = np.arange(len(g))
    fig, ax = plt.subplots(figsize=(8.5, 0.32 * len(g) + 1.4), dpi=150)
    fig.patch.set_facecolor(SURFACE)
    _style(ax)
    for x, label in ((0.5, "supporting"), (0.9, "strong")):
        ax.axvline(x, color=MUTED, linewidth=1, linestyle=(0, (3, 3)), zorder=1)
        ax.text(x, len(g) - 0.3, label, color=INK2, fontsize=8, ha="center", va="bottom")
    ax.hlines(y, legit, g["best_tool_rate"], color=GRID, linewidth=2, zorder=2)
    ax.scatter(legit, y, s=46, color=ORANGE, edgecolor=SURFACE, linewidth=1.5, zorder=3, label="Worse of C1 / C2")
    ax.scatter(g["best_tool_rate"], y, s=46, color=BLUE, edgecolor=SURFACE, linewidth=1.5, zorder=4,
               label="Best-caught target tool")
    ax.set_yticks(y, [f"{f}  ({gr})" for f, gr in zip(g["flag"], g["grade"])], fontsize=8.5, color=INK)
    ax.set_xlim(-0.02, 1.02)
    ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0))
    ax.set_xlabel("Share of visits on which the flag fired", color=INK2, fontsize=9)
    ax.set_title("Each signal: how often it catches its target vs. how often it hits real people",
                 color=INK, fontsize=11, loc="left", pad=22)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=2, frameon=False, fontsize=8.5,
              labelcolor=INK2, handletextpad=0.3, borderaxespad=0.2)
    fig.tight_layout()
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)
    return out


def gap_chart(df: pd.DataFrame, threshold: float | None, out: Path) -> Path | None:
    """Strip plot of the RTT gap per cohort on a log axis. C1 and C2 (the cohorts the
    threshold comes from) in blue, the rest in gray; the dashed line is the suggested threshold."""
    d = df[df["gap_ms"].notna() & (df["gap_ms"] > 0)]
    if d.empty:
        return None
    order = [c for c in ("C1", "C2", "C3", "C4", "C5", "C6", "unlabeled") if c in set(d["cohort"])]
    rng = np.random.default_rng(3)
    fig, ax = plt.subplots(figsize=(8.5, 0.55 * len(order) + 1.3), dpi=150)
    fig.patch.set_facecolor(SURFACE)
    _style(ax)
    for i, c in enumerate(order[::-1]):
        v = d.loc[d["cohort"] == c, "gap_ms"].to_numpy()
        col = BLUE if c in ("C1", "C2") else MUTED
        ax.scatter(v, i + rng.uniform(-0.18, 0.18, len(v)), s=14, color=col, alpha=0.75, linewidth=0, zorder=3)
        ax.text(v.max() * 1.15, i, f"n={len(v)}", color=INK2, fontsize=8, va="center")
    if threshold:
        ax.axvline(threshold, color=ORANGE, linewidth=1.5, linestyle=(0, (4, 3)), zorder=2)
        ax.text(threshold, len(order) - 0.45, f" suggested RTT_GAP_MS = {threshold:g}", color=INK, fontsize=8.5, va="bottom")
    ax.set_xscale("log")
    ax.set_yticks(range(len(order)), order[::-1], fontsize=9, color=INK)
    ax.set_xlabel("RTT gap (page ping minus TCP round-trip), ms, log scale", color=INK2, fontsize=9)
    ax.set_title("Hidden hops: how much slower the page ping is than the TCP connection",
                 color=INK, fontsize=11, loc="left", pad=18)
    fig.tight_layout()
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)
    return out
