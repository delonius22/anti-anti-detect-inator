"""pytest for the Phase 6 toolkit. Uses synthetic data; set NODE_VISITS_DB to also
check a visits.db produced by the real capture app."""
import json
import os
from pathlib import Path

import pandas as pd
import pytest

from inator_analysis.demo import make_demo_db
from inator_analysis.exit_criteria import evaluate
from inator_analysis.fit import fit_all, split_by_run_date
from inator_analysis.grading import grade_signals, grade_one
from inator_analysis.load import load, flag_columns
from inator_analysis.population import device_linkage, tool_traces
from inator_analysis.report import build_report
from inator_analysis.thresholds import suggest_rtt_gap_ms


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    return make_demo_db(tmp_path_factory.mktemp("d") / "visits.db")


@pytest.fixture(scope="module")
def df(demo):
    return load(demo)


def test_loader_flattens_everything(df):
    assert len(df) == 600
    assert set(df["cohort"]) == {"C1", "C2", "C3", "C4", "C5", "C6"}
    assert "flag:J1-webdriver" in df.columns and df.attrs["flag_sides"]["J1-webdriver"] == "agent"
    assert df.loc[df["cohort"] == "C5", "js_ran"].eq(False).all()
    assert df["page_rtt_min_ms"].notna().sum() > 400


def test_grade_rules():
    assert grade_one(0.95, 0.0, 0.02) == "strong"
    assert grade_one(0.95, 0.03, 0.02) == "supporting"
    assert grade_one(0.60, 0.06, 0.0) == "dropped"


def test_tool_specific_signal_is_not_buried(df):
    g = grade_signals(df).set_index("flag")
    assert g.loc["J1-webdriver", "best_tool"] == "playwright-headless"
    assert g.loc["J1-webdriver", "grade"] == "strong"
    assert g.loc["J1-webdriver", "pooled_target_rate"] < 0.5   # pooling would have dropped it


def test_split_never_shares_a_run_date(df):
    tr, te, how = split_by_run_date(df)
    assert set(df.loc[tr, "run_date"]).isdisjoint(set(df.loc[te, "run_date"]))
    assert "run date" in how


def test_single_run_date_falls_back_to_whole_links(df):
    one = df.copy(); one["run_date"] = one["run_date"].iloc[0]
    tr, te, how = split_by_run_date(one)
    assert set(one.loc[tr, "link_id"]).isdisjoint(set(one.loc[te, "link_id"]))
    assert "link" in how


def test_weights_are_non_negative_by_default(df):
    fits = fit_all(df)
    for f in fits.values():
        assert f.ok, f.message
        assert all(w > 0 for w in f.weights.values())
        assert f.threshold is not None
    assert fits["agent"].weights.get("J1-webdriver", 0) > 0


def test_negative_weights_only_when_asked(df):
    fits = fit_all(df, allow_negative=True)
    assert any(w < 0 for f in fits.values() for w in f.weights.values())


def test_population_finds_shared_machines_and_tool_traces(df):
    link = device_linkage(df)
    assert not link.empty
    # Collisions among real people can happen (same laptop, same ISP); the ranking
    # must still put automation first: anti-detect machines and cloud-agent fleets
    # built from one image both rotate identities on identical hardware.
    top = set(",".join(link.head(3)["cohorts"]).split(","))
    assert "C6" in top and not top & {"C1", "C2"}
    traces = tool_traces(df)
    assert ((traces["tool"] == "adspower") & (traces["field"] == "non_native")).any()


def test_rtt_gap_threshold(df):
    s = suggest_rtt_gap_ms(df)
    assert isinstance(s["value"], int) and s["value"] > 0 and s["n"] == 240


def test_exit_criteria_rows(df):
    crit = evaluate(df, fit_all(df))
    assert len(crit) == 7
    assert set(crit["status"]) <= {"PASS", "FAIL", "NOT YET"}
    assert crit.iloc[0]["status"] == "PASS"   # demo ChatGPT cloud visits are all verified


def test_report_writes_all_outputs(demo, tmp_path):
    path = build_report(demo, tmp_path / "out")
    names = {p.name for p in (tmp_path / "out").iterdir()}
    assert {"report.md", "signal_grades.csv", "weights.json", "signal_grades.png", "rtt_gap.png",
            "exit_criteria.csv", "device_linkage.csv", "tool_traces.csv"} <= names
    w = json.loads((tmp_path / "out" / "weights.json").read_text())
    assert set(w) == {"agent", "antidetect"}
    assert "Exit criteria" in path.read_text()


@pytest.mark.skipif(not os.environ.get("NODE_VISITS_DB"), reason="set NODE_VISITS_DB to a capture-app visits.db")
def test_real_capture_app_db(tmp_path):
    d = load(os.environ["NODE_VISITS_DB"])
    assert len(d) >= 1 and flag_columns(d)
    grade_signals(d); fit_all(d)               # must not raise on tiny, unlabeled data
    build_report(os.environ["NODE_VISITS_DB"], tmp_path / "real")


# ---- System 1 model --------------------------------------------------------
from inator_analysis.model import CLASSES, build_matrix, parity_cases, tag_visits, train_and_evaluate  # noqa: E402


@pytest.fixture(scope="module")
def mrep(df):
    r = train_and_evaluate(df)
    assert r.ok, r.message
    return r


def test_model_is_calibrated_and_accurate_on_holdout(mrep):
    m = mrep.holdout["logistic"]
    assert m["accuracy"] > 0.85 and m["ece"] < 0.1
    assert set(mrep.holdout) == {"logistic", "boosted"}


def test_model_json_has_everything_node_needs(mrep):
    j = mrep.exported.to_json()
    assert j["format"] == "inator-logistic-v1" and j["classes"] == CLASSES
    n = len(j["features"])
    assert len(j["mean"]) == len(j["scale"]) == n and len(j["coef"]) == 3 and len(j["coef"][0]) == n
    assert j["temperature"] > 0 and abs(sum(j["train_priors"].values()) - 1) < 1e-9


def test_tags_probabilities_reasons_and_verified_override(df, mrep):
    t = tag_visits(df, mrep)
    assert {"p_human", "p_agent", "p_antidetect", "tag", "reasons"} <= set(t.columns)
    assert (t[["p_human", "p_agent", "p_antidetect"]].sum(axis=1) - 1).abs().max() < 1e-3
    assert t.loc[t["tool"] == "chatgpt-cloud", "tag"].str.startswith("agent (verified").all()
    pw = t[t["tool"] == "playwright-headless"]
    assert (pw["tag"] == "agent").mean() > 0.8


def test_live_priors_shift_toward_human(df, mrep):
    lab = tag_visits(df, mrep, use="logistic")["p_human"].mean()
    live = tag_visits(df, mrep, priors={"human": 0.97, "agent": 0.02, "antidetect": 0.01}, use="logistic")["p_human"].mean()
    assert live > lab


def test_parity_cases_reproduce_python_probabilities(df, mrep):
    cases = parity_cases(df, mrep.exported, n=10)
    assert len(cases) == 10 and all(abs(sum(c["expected"].values()) - 1) < 1e-9 for c in cases)


def test_model_needs_all_three_classes(df):
    only = df[df["cohort"].isin(["C1", "C2", "C3"])].copy(); only.attrs = df.attrs
    r = train_and_evaluate(only)
    assert not r.ok and "three classes" in r.message


# ---- CreepJS / FingerprintJS columns, rarity and impossible combinations ----
from inator_analysis.population import id_linkage  # noqa: E402
from inator_analysis.rarity import (attribute_entropy, coarse, gpu_family, impossible_combinations,  # noqa: E402
                                    surprisal, ua_os)


def test_probe_columns_are_loaded(df):
    assert df.loc[df["cohort"] == "C5", "probes_ran"].eq(False).all()      # no JS, no probes
    assert df.loc[df["cohort"] == "C6", "creep_lies"].mean() > df.loc[df["cohort"] == "C1", "creep_lies"].mean()
    assert any(c.startswith("h:") for c in df.columns)
    assert "flag:C2-headless-traits" in df.columns and df.attrs["flag_sides"]["C2-headless-traits"] == "agent"


def test_model_uses_probe_numbers(mrep):
    names = {f["name"] for f in mrep.exported.spec}
    assert {"probes_ran", "log_creep_lies", "creep_headless_pct", "creep_stealth_pct"} <= names


def test_coarse_values():
    assert ua_os("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)") == "macOS"
    assert gpu_family("ANGLE (NVIDIA, GeForce RTX 4070)") == "NVIDIA" and gpu_family("ANGLE (Google, SwiftShader)") == "SwiftShader"


def test_surprisal_leave_one_out_and_ranking(df):
    s = surprisal(df).set_index("visit_id")
    by = s.groupby("cohort")["surprisal_bits_mean"].median()
    assert by["C6"] > by["C1"] and by["C6"] > by["C2"]
    # leave-one-out: a person whose values others share is never "unseen" because of itself
    assert (s.loc[s["cohort"] == "C1", "unseen_values"] == 0).mean() > 0.9
    pct = s.loc[s["cohort"].isin(["C1", "C2"]), "surprisal_pct_vs_people"]
    assert pct.between(0, 1).all() and 0.3 < pct.median() < 0.7


def test_entropy_table(df):
    e = attribute_entropy(df).set_index("attribute")
    assert e.loc["ja4t", "entropy_bits"] < e.loc["h:canvas2d", "entropy_bits"] + 5   # both present and finite
    assert (e["normalized"].between(0, 1)).all()


def test_impossible_pairs_catch_claimed_os_on_other_hardware(df):
    imp = impossible_combinations(df)
    rate = imp.groupby("cohort")["impossible_pairs"].apply(lambda s: (s > 0).mean())
    assert rate["C1"] <= 0.02 and rate["C2"] <= 0.02 and rate["C6"] > 0.5
    c6 = imp.loc[imp["cohort"] == "C6", "impossible_detail"].dropna()
    assert c6.str.contains("ua_os=macOS & gpu_family=NVIDIA").any()


def test_impossible_needs_support():
    d = pd.DataFrame({"visit_id": list("abcde"), "cohort": ["C1"] * 4 + ["C6"], "tool": [""] * 5,
                      "user_agent": ["Windows NT"] * 4 + ["Mac OS X"], "webgl_renderer": ["NVIDIA"] * 5})
    # macOS never appears among people, so the pair cannot be judged: no hit
    assert impossible_combinations(d)["impossible_pairs"].sum() == 0
    assert coarse(d)["gpu_family"].eq("NVIDIA").all()


def test_id_linkage_finds_rotating_profiles(df):
    link = id_linkage(df)
    assert not link.empty
    top = link.iloc[0]
    assert "C6" in top["cohorts"] and top["user_agents"] >= 2


def test_report_has_rarity_outputs(demo, tmp_path):
    build_report(demo, tmp_path)
    t = pd.read_csv(tmp_path / "tags.csv")
    assert {"surprisal_bits_mean", "impossible_pairs", "impossible_detail"} <= set(t.columns)
    assert (tmp_path / "rarity_by_visit.csv").exists() and (tmp_path / "attribute_entropy.csv").exists()
    assert "Rarity and impossible combinations" in (tmp_path / "report.md").read_text()
