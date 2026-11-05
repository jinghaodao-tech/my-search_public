# FTS5 morphology / Porter transfer plan

## Status and provenance

This is an exploratory transfer plan written after observing the SHA-256-selected 100-query ArguAna test subset. That ArguAna result is discovery evidence, not confirmatory evidence. SciFact and NFCorpus qrels have prior use in this repository's broader BM25 exploration, so these runs are fixed-transfer diagnostics and are not independent untouched holdouts.

## Frozen comparison

- Dataset splits: the existing official BEIR test files for SciFact and NFCorpus.
- Query sample: the ascending SHA-256 order of query ID, first 100 queries, selected before computing metrics.
- Shared parser: unchanged `purposeWords()` + `analyzeQuery()`.
- Full corpus per dataset; positive relevance is grade > 0; paired bootstrap resamples connected components of the positive query-document qrel graph.
- Methods: current exact-token morphology BM25 (k1=1.2,b=0.75); SQLite FTS5 morphology BM25 over reversible encoding of those exact document/query morphology tokens; SQLite FTS5 unicode61 raw BM25; SQLite FTS5 built-in Porter+unicode61 BM25; existing equal-weight RRF configurations in the same harness.
- No parameter tuning, qrel edits, candidate truncation, or outcome-based query selection.
- Primary transfer metric: nDCG@10 difference versus standard BM25. Report all registered metrics and 95% paired cluster-bootstrap intervals; do not call a 100-query sample a final statistical certification.
- Report complete-corpus index construction time, per-query p50/p95, and process memory as observed by the existing harness.

## Decision rule

The ArguAna observation only motivates this transfer. A candidate is not called generally superior based on these datasets. Any candidate whose primary interval includes zero or whose improvement is inconsistent across domains remains exploratory. The existing production ranking is not changed by this experiment.

## Disjoint SciFact follow-up block

After the first fixed SciFact hash block was observed, FTS5 morphology was selected as the sole follow-up candidate because it preserves the exact shared morphology token stream and showed a small positive nDCG point estimate across the first two 100-query diagnostics. This selection is exploratory and outcome-informed; the next block cannot establish a globally untouched holdout. Before running it, freeze the next SciFact test queries as hash ranks 100 through 199 (ascending SHA-256 query-ID order), with no changes to the standard or FTS5 morphology algorithms. Primary contrast: paired nDCG@10 difference, using the existing positive-qrel connected components. Do not tune based on this block. The other output methods are incidental and will not be used to select another candidate from this block.

## Results (2026-10-24)

All runs used the same parser, full corpus, and official test qrels, with the SHA-256 query blocks described above. The ArguAna 100-query hash block was the discovery run. SciFact hash ranks 0-99 and 100-199 are separate query-ID blocks; the latter was run without changing either candidate. NFCorpus is included as a transfer diagnostic, but its selected 100 queries form only one positive-qrel connected component, so its bootstrap interval is degenerate and must not be interpreted inferentially.

| Dataset / fixed sample | Positive-qrel components | Standard nDCG@10 | FTS5 morphology difference (95% paired cluster CI) | FTS5 Porter difference (95% paired cluster CI) |
|---|---:|---:|---:|---:|
| ArguAna test, first 100 SHA-ranked | 100 | 0.31041 | +0.00751 [+0.00012,+0.01727] | +0.01792 [-0.00695,+0.04312] |
| SciFact test, SHA ranks 0-99 | 91 | 0.64178 | +0.00400 [0,+0.01188] | +0.01448 [-0.02629,+0.05744] |
| SciFact test, SHA ranks 100-199 | 95 | 0.70451 | -0.00708 [-0.01826,+0.00107] | -0.00821 [-0.04179,+0.02278] |
| NFCorpus test, first 100 SHA-ranked | 1 | 0.31254 | +0.00071 (CI non-informative: one cluster) | +0.01013 (CI non-informative: one cluster) |

The initial ArguAna signal did not replicate in the disjoint SciFact block: both FTS5 morphology and Porter had negative nDCG point estimates there. Porter was directionally positive in the first blocks but all corresponding intervals included zero. FTS5 morphology had one small positive ArguAna interval and a SciFact first-block lower endpoint at zero, followed by a negative independent query block. This is not stable superiority. Raw unicode61 also did not show consistent gains. No production ranking change is warranted.

The harness reports combined per-query latency over all rankers, not per-engine latency: p50/p95 were 295/442 ms for ArguAna, 45.5/74.8 ms for SciFact hash ranks 0-99, 38.4/80.8 ms for SciFact ranks 100-199, and 5.8/41.1 ms for NFCorpus. Full-corpus tokenization/index construction took 155s, 239s, 245s, and 122s respectively. The recorded process RSS is a final process sample, about 0.82-1.06 GB, not a per-engine peak or incremental memory measurement.

Artifacts (ignored local evaluation data):

- `quality/e2e/artifacts/arguana-fts5-porter-test-hash100-20261024.json`
- `quality/e2e/artifacts/scifact-fts5-porter-test-hash100-20261024.json`
- `quality/e2e/artifacts/scifact-fts5-morph-test-hash100-offset100-20261024.json`
- `quality/e2e/artifacts/nfcorpus-fts5-porter-test-hash100-20261024.json`
