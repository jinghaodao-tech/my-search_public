# Search Quality Evaluation

The repository includes a deterministic search-quality evaluation in addition to latency benchmarks.

## Dataset

The evaluation uses 40 documents and 15 hand-labeled English/Japanese queries. It includes relevant documents, unrelated documents, terminology variation, short and long text, and Japanese queries.

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

The current run reports the dataset size, per-case metrics, aggregate metrics, and variant comparison. Exact values should be refreshed whenever ranking logic or tokenization changes.

## Limits

This is a deterministic regression fixture, not a general web-search benchmark. Relevance labels are intentionally small and curated for portfolio-level regression detection.

FTS5 and vector search remain comparison candidates only and are not production dependencies.