# Search Quality Evaluation

Speed alone does not prove that a search app returns useful results. My Search App includes a small deterministic search-quality evaluation so ranking behavior can be discussed alongside benchmark timings.

## Dataset

The evaluation script uses a fixed in-repo dataset with cards/articles about BM25 token caching, Zettelkasten backlinks, and CSV/JSON import validation. Each query defines the expected relevant top result.

## Metrics

The first version reports:

- Precision@1: whether the top result is an expected relevant result.
- MRR: how high the first expected result appears in the ranking.

These are intentionally small but easy to reproduce locally and in CI.

## Run

```bash
npm run evaluate:search
```

## Current Result

The current fixed evaluation returns the target item at rank 1 for each case: `meanPrecisionAt1 = 1.0` and `MRR = 1.0`. Exact values should be refreshed whenever ranking logic or tokenization changes.

## Limits

The dataset is small and hand-labeled, so it is not a research benchmark. It exists to catch obvious ranking regressions and to document search-quality thinking in the portfolio.

## Future Comparisons

Useful future comparisons would include:

- Current BM25 implementation
- Simple keyword matching baseline
- SQLite FTS5
- Vector search or hybrid lexical/vector ranking

FTS5 and vector search are comparison candidates only; they are not implemented in this closing pass because they would add scope beyond the local-first portfolio cleanup.
