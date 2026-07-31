# Search Quality Evaluation

The repository includes a deterministic search-quality evaluation in addition to latency benchmarks.

## Dataset

The evaluation uses 50 documents and 20 hand-labeled English/Japanese queries (dataset version v2-50-docs-20-queries). It includes relevant documents, unrelated documents, terminology variation, short and long text, and Japanese queries.

## Metrics

- Precision@1 and Precision@3
- Mean Reciprocal Rank (MRR)
- Recall@5
- nDCG@5

The script also compares current BM25 against variants without synonym expansion and without time decay.

## Run

```bash
npm run evaluate:search
```

The current run reports the dataset size, per-case metrics, aggregate metrics, variant comparison, thresholds, and writes artifacts/search-quality.json. The latest run passes all 20 cases with Precision@1 1.00, MRR 1.00, Recall@5 1.00, and nDCG@5 1.00. The gate requires Precision@1 >= 0.85, MRR >= 0.90, Recall@5 >= 0.90, and nDCG@5 >= 0.85. Exact values should be refreshed whenever ranking logic or tokenization changes.

## Limits

This is a deterministic regression fixture, not a general web-search benchmark. Relevance labels are intentionally small and curated for portfolio-level regression detection.

FTS5 is now a production-capable local index through `HybridSearchEngine`; vector search remains a comparison candidate only.
