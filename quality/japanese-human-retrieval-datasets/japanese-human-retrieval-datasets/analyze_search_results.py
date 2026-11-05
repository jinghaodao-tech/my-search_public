#!/usr/bin/env python3
"""Describe benchmark ranks and exact lexical overlap with gold answer texts."""
import argparse
import json
import math
import statistics
import unicodedata
from pathlib import Path


def jsonl(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def norm(value):
    return unicodedata.normalize("NFKC", value or "").casefold()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--dataset-dir", type=Path, required=True)
    parser.add_argument("--stage", choices=("development", "validation"), required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    results = json.loads(args.results.read_text(encoding="utf-8"))["all_results"]
    queries = {item["id"]: item for item in jsonl(args.dataset_dir / f"{args.stage}.jsonl")}
    documents = {item["id"]: item for item in jsonl(args.dataset_dir / "documents.jsonl")}
    rows = []
    for result in results:
        query = queries[result["qid"]]
        terms = result.get("keyword_terms", [])
        gold = [documents[doc_id] for doc_id in query["gold_ids"] if doc_id in documents]
        gold_text = norm(" ".join(
            f"{doc.get('title', '')} {doc.get('body', '')} {doc.get('summary', '')}"
            for doc in gold
        ))
        matched = [term for term in terms if norm(term) and norm(term) in gold_text]
        row = {
            "qid": result["qid"],
            "group_id": result.get("group_id"),
            "query": query["query"],
            "terms": terms,
            "rank": result.get("rank"),
            "status": result.get("status"),
            "latency_ms": float(result.get("latency_ms", 0)),
            "gold_ids": query["gold_ids"],
            "missing_gold_count": len(query["gold_ids"]) - len(gold),
            "gold_title": gold[0].get("title", "") if gold else "MISSING FROM CORPUS",
            "gold_text": " ".join((gold[0].get("body", "") or "").split())[:500] if gold else "",
            "term_overlap": len(matched) / len(terms) if terms else 0.0,
            "matched_terms": matched,
            "unmatched_terms": [term for term in terms if term not in matched],
            "hit10": bool(result.get("success")),
        }
        rows.append(row)

    ranked = [row for row in rows if isinstance(row["rank"], int) and row["rank"] <= 10]
    n = len(rows)
    mrr = sum(1 / row["rank"] for row in rows if isinstance(row["rank"], int)) / n
    ndcg10 = sum(1 / __import__("math").log2(row["rank"] + 1)
                 for row in ranked) / n
    groups = {}
    for row in rows:
        groups.setdefault(row["group_id"], []).append(row)
    overlap_by_hit = {
        label: (sum(row["term_overlap"] for row in rows if row["hit10"] is value)
                / max(1, sum(row["hit10"] is value for row in rows)))
        for label, value in (("hit10", True), ("miss10", False))
    }
    latencies = sorted(float(row.get("latency_ms", 0)) for row in rows)
    p95_index = min(len(latencies) - 1, math.ceil(0.95 * len(latencies)) - 1)
    status_counts = {}
    for row in rows:
        status_counts[row.get("status", "missing")] = status_counts.get(row.get("status", "missing"), 0) + 1
    report = {
        "n": n,
        "hit1": sum(row["rank"] == 1 for row in rows) / n,
        "hit10": len(ranked) / n,
        "mrr": mrr,
        "ndcg10": ndcg10,
        "gold_missing_from_corpus": sum(row["missing_gold_count"] for row in rows),
        "query_groups": len(groups),
        "repeated_gold_groups": sum(len(items) > 1 for items in groups.values()),
        "mean_exact_query_term_overlap": overlap_by_hit,
        "status_counts": status_counts,
        "latency_ms": {
            "median": statistics.median(latencies),
            "p95_nearest_rank": latencies[p95_index],
            "max": max(latencies, default=0),
        },
        "misses": [row for row in rows if not row["hit10"]][:args.limit],
    }
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)


if __name__ == "__main__":
    main()
