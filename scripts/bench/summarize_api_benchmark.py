#!/usr/bin/env python3
"""Print aggregate-only metrics for an isolated API benchmark JSON file."""

import argparse
import json
import random
from pathlib import Path


def cluster_bootstrap(results, samples, seed):
    groups = {}
    for row in results:
        counts = groups.setdefault(str(row["group_id"]), [0, 0])
        counts[0] += int(bool(row.get("success")))
        counts[1] += 1

    group_ids = list(groups)
    rng = random.Random(seed)
    rates = []
    for _ in range(samples):
        selected = rng.choices(group_ids, k=len(group_ids))
        successes = sum(groups[group_id][0] for group_id in selected)
        total = sum(groups[group_id][1] for group_id in selected)
        rates.append(successes / total if total else 0.0)
    rates.sort()
    low_index = max(0, int(0.025 * samples))
    high_index = min(samples - 1, int(0.975 * samples) - 1)
    return len(group_ids), rates[low_index], rates[high_index]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path, help="local benchmark JSON; query text is never printed")
    parser.add_argument("--bootstrap-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20261026)
    args = parser.parse_args()
    report = json.loads(args.result.read_text(encoding="utf-8"))
    profiles = report.get("profiles") or {report["profile"]: report}
    output = {
        "dataset": report.get("dataset"),
        "domain": report.get("domain"),
        "stage": report.get("stage"),
        "source_sha256": report.get("source_sha256"),
        "build_source_fingerprint": report.get("build_source_fingerprint"),
        "method": report.get("method"),
        "bootstrap": {
            "unit": "group_id cluster, resampled with replacement",
            "samples": args.bootstrap_samples,
            "seed": args.seed,
            "interval": "percentile 95%",
        },
        "profiles": {},
    }
    for name, profile in profiles.items():
        results = profile.get("all_results", report.get("all_results", []))
        stats = profile["stats"]
        groups, low, high = cluster_bootstrap(results, args.bootstrap_samples, args.seed)
        output["profiles"][name] = {
            "n": stats["n"],
            "successes": stats["successes"],
            "hit_at_10": stats["observed"],
            "group_count": groups,
            "group_bootstrap_95ci": [low, high],
            "api_error_count": sum(
                str(row.get("status", "")).startswith("request_error") for row in results
            ),
            "latency_median_ms": profile.get("latency_ms_median", report.get("latency_ms_median")),
            "latency_p95_ms": profile.get("latency_ms_p95", report.get("latency_ms_p95")),
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
