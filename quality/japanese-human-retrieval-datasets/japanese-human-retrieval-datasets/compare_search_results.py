#!/usr/bin/env python3
"""Paired Hit@10 comparison with resampling at shared-target cluster level."""
import argparse
import json
import math
import random
from collections import defaultdict
from pathlib import Path


def load_report(path: Path, profile=None):
    report = json.loads(path.read_text(encoding="utf-8"))
    if profile is not None:
        profiles = report.get("profiles") or {}
        if profile not in profiles:
            raise ValueError(f"{path}: unknown profile {profile!r}")
        report = profiles[profile]
    raw = report.get("all_results", report.get("results"))
    if not isinstance(raw, list):
        raise ValueError(f"{path}: no query result list")
    rows = {}
    for item in raw:
        qid = str(item.get("qid", item.get("id", "")))
        if not qid or qid in rows:
            raise ValueError(f"{path}: missing or duplicate query id {qid!r}")
        expected = item.get("expected", item.get("gold_ids"))
        if not isinstance(expected, list) or not expected:
            raise ValueError(f"{path}: missing expected IDs for {qid}")
        hit = item.get("success")
        if type(hit) is not bool:
            rank = item.get("rankTop10")
            hit = isinstance(rank, int) and 1 <= rank <= 10
        rows[qid] = {
            "expected": sorted(map(str, expected)),
            "group": str(item.get("group_id", item.get("groupId", qid))),
            "hit": hit,
        }
    return rows


def quantile(values, p):
    ordered = sorted(values)
    index = p * (len(ordered) - 1)
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--baseline-profile")
    parser.add_argument("--candidate-profile")
    parser.add_argument("--bootstrap", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=20261021)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    baseline = load_report(args.baseline, args.baseline_profile)
    candidate = load_report(args.candidate, args.candidate_profile)
    if baseline.keys() != candidate.keys():
        raise ValueError("paired reports must contain exactly the same query IDs")
    for qid in baseline:
        if baseline[qid]["expected"] != candidate[qid]["expected"]:
            raise ValueError(f"gold labels changed for query {qid}")

    groups = defaultdict(list)
    for qid, before in baseline.items():
        after = candidate[qid]
        if before["group"] != after["group"]:
            raise ValueError(f"cluster changed for query {qid}")
        groups[before["group"]].append((before["hit"], after["hit"]))

    n = len(baseline)
    before_hits = sum(before["hit"] for before in baseline.values())
    after_hits = sum(after["hit"] for after in candidate.values())
    observed = (after_hits - before_hits) / n
    group_rows = list(groups.values())
    rng = random.Random(args.seed)
    samples = []
    for _ in range(args.bootstrap):
        selected = [rng.choice(group_rows) for _ in range(len(group_rows))]
        hit_delta = sum(int(after) - int(before) for group in selected for before, after in group)
        query_count = sum(len(group) for group in selected)
        samples.append(hit_delta / query_count)
    centered = [value - observed for value in samples]
    p_value = min(1.0, (sum(abs(value) >= abs(observed) for value in centered) + 1) / (args.bootstrap + 1))
    discordant = sum(before != after for before, after in ((baseline[q]["hit"], candidate[q]["hit"]) for q in baseline))
    improved = sum(not baseline[q]["hit"] and candidate[q]["hit"] for q in baseline)
    worsened = discordant - improved
    independent_targets = all(len(rows) == 1 for rows in group_rows)
    exact_p = (min(1.0, 2 * sum(math.comb(discordant, k) for k in range(min(improved, worsened) + 1))
                   / (2 ** discordant)) if discordant else 1.0) if independent_targets else None
    result = {
        "n": n,
        "clusters": len(groups),
        "repeated_clusters": sum(len(rows) > 1 for rows in group_rows),
        "baseline_hit10": before_hits / n,
        "candidate_hit10": after_hits / n,
        "paired_difference": observed,
        "cluster_bootstrap_95pct_ci": [quantile(samples, 0.025), quantile(samples, 0.975)],
        "centered_cluster_bootstrap_two_sided_p": p_value,
        "discordant_queries": discordant,
        "improved_queries": improved,
        "worsened_queries": worsened,
        "exact_mcnemar_two_sided_p": exact_p,
        "bootstrap_replicates": args.bootstrap,
        "seed": args.seed,
        "note": "Exploratory when used on development/validation; not a substitute for the sealed final holdout.",
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)


if __name__ == "__main__":
    main()
