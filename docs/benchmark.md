# BM25 Benchmark

Generated: 2026-08-12T10:12:12.364Z

Command:

```bash
npm run benchmark
```

The benchmark uses deterministic synthetic card corpora with precomputed `tokens` and `docLength`, matching the production SQLite design where `tokens_json` and `doc_length` are generated on write instead of tokenizing every card during search.

Ranking, production-like, and end-to-end pipeline rows are measured independently. The first-pipeline-call row has no prior pipeline warm-up; the repeated-pipeline-call row performs an excluded warm-up immediately before its measured call.

## Results

| Corpus size | DB load | Token parse / preparation | BM25 scoring | Sorting / limiting | Total search | Returned |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 3.023 ms | 4.676 ms | 3.554 ms | 0.16 ms | 534.763 ms | 100 |
| 1,000 | 3.587 ms | 6.245 ms | 14.399 ms | 0.499 ms | 22.835 ms | 100 |
| 5,000 | 0.993 ms | 38.127 ms | 46.284 ms | 2.673 ms | 90.693 ms | 100 |
| 10,000 | 1.199 ms | 48.384 ms | 94.112 ms | 3.6 ms | 156.805 ms | 100 |

## Scope Results

| Scope | Corpus | Elapsed | Dedup | Result limit |
|---|---:|---:|---|---:|
| ranking-only | 10,000 | 129.333 ms | disabled | 100 |
| production-like | 5,000 | 2,821.705 ms | enabled | 100 |
| end-to-end-pipeline | 1,000 | 18.978 ms | disabled | 100 |
| first-pipeline-call | 100 | 3.682 ms | disabled | 100 |
| repeated-pipeline-call | 100 | 3.704 ms | disabled | 100 |

## End-to-end HTTP

Run `npm run benchmark:http` to measure an actual `GET /api/cards` route with first-http-request-after-server-start and warm-http-request timings. This is kept separate from the deterministic ranking corpus table.

## Before / After

Historical baseline before token precomputation:

| Stage | Before | Current benchmark focus |
|---|---:|---:|
| Load cards | 2.175 ms | measured as DB load |
| Tokenize | 4.584 s | measured as token parse / preparation |
| Score | 4.705 s | measured as BM25 scoring |
| Total BM25 | 9.705 s | measured as total search |

## What Changed

- Search uses precomputed `tokens_json` and `doc_length` instead of running morphological tokenization for every card on every query.
- BM25 scoring avoids creating one Promise per card because scoring is CPU-bound and synchronous.
- Benchmarks now report DB load, token preparation, scoring, sorting/limiting, and total search separately.
- Benchmark corpora cover 100, 1,000, 5,000, and 10,000 cards.
- First-pipeline-call intentionally includes first-call cost; repeated-pipeline-call excludes only its own pre-measurement warm-up.
- Deduplication is skipped when `dedupThreshold >= 1`, which is the expected benchmark and acceptance-test setting for measuring ranking rather than duplicate detection.

## Remaining Bottlenecks

- Token arrays still need to be normalized and counted into term-frequency maps during each search.
- Full result sorting is still used after scoring; a bounded top-K heap could reduce work for small esultLimit` values.
- DB load is measured separately here, but production searches still parse `tokens_json` from SQLite rows into JavaScript arrays.

## Why This Matters

BM25 is only useful in the GUI if search latency stays predictable as the local-first card corpus grows. Separating benchmark stages makes future regressions easier to diagnose and makes the next optimization target clear.


## Candidate pipeline scopes

| Scope | Corpus | Elapsed | After dedup | Active |
|---|---:|---:|---:|---:|
| candidate-pipeline-near-duplicate | 200 | 60.286 ms | 1 | 1 |
| candidate-pipeline-diverse | 200 | 3.879 ms | 200 | 200 |