# Search Quality Evaluation

The repository includes a deterministic search-quality evaluation in addition to latency benchmarks.

## Dataset

The evaluation uses 50 documents and 11 hand-labeled English/Japanese queries (dataset version v4-50-docs-11-query-cases). It includes clear positives, near-negatives, title/body conflicts, time-decay traps, parser ambiguity, short and long text, and Japanese queries.

## Metrics

- Precision@1 and Precision@3
- Mean Reciprocal Rank (MRR)
- Recall@5
- nDCG@5

The script also compares current BM25 against variants without synonym expansion and without time decay. Each variant is labeled with a stable `name` and `description` in the artifacts.

## Run

```bash
npm run evaluate:search
```

The current run reports the dataset size, per-case metrics, aggregate metrics, variant comparison, thresholds, score breakdowns, tokenization diagnostics, and failure-case tables. The latest run reports ranking-only Precision@1 0.818, Precision@3 0.485, MRR 0.882, Recall@5 1.000, and nDCG@5 0.896. End-to-end query parsing reports Precision@1 0.818, Precision@3 0.470, MRR 0.894, Recall@5 1.000, and nDCG@5 0.906. The gate requires Precision@1 >= 0.75, Precision@3 >= 0.45, MRR >= 0.80, Recall@5 >= 0.80, and nDCG@5 >= 0.75. Exact values should be refreshed whenever ranking logic or tokenization changes.

`artifacts/search-quality.json` includes `rankingDetails` for every case with `documentId`, `rank`, `finalScore`, `bm25Score`, `timeDecayFactor`, `matchedTerms`, and `isExpected`. It also includes `failureCases`, a near-negative success table, and `tokenizationDiagnostics` with implementation locations and executed token samples.

## Limits

This is a deterministic regression fixture, not a general web-search benchmark. Relevance labels are intentionally small and curated for portfolio-level regression detection.

FTS5 is now a production-capable local index through `HybridSearchEngine`; vector search remains a comparison candidate only.
