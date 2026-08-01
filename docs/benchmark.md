# BM25 Benchmark

Generated: 2026-08-01T07:04:46.772Z

Command:

```bash
npm run benchmark
```

The benchmark uses deterministic synthetic card corpora with precomputed `tokens` and `docLength`, matching the production SQLite design where `tokens_json` and `doc_length` are generated on write instead of tokenizing every card during search.

The script performs one 100-card warm-up search before recording results. This excludes first-run tokenizer initialization and JavaScript runtime warm-up from the measured rows.

## Results

| Corpus size | DB load | Token parse / preparation | BM25 scoring | Sorting / limiting | Total search | Returned |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 4.744 ms | 1.921 ms | 1.726 ms | 0.145 ms | 5.354 ms | 100 |
| 1,000 | 1.139 ms | 3.478 ms | 6.337 ms | 0.504 ms | 12.412 ms | 100 |
| 5,000 | 2.043 ms | 9.277 ms | 49.851 ms | 4.53 ms | 67.131 ms | 100 |
| 10,000 | 1.008 ms | 18.622 ms | 60.741 ms | 16.917 ms | 104.483 ms | 100 |

## Scope Results

| Scope | Corpus | Elapsed | Dedup | Result limit |
|---|---:|---:|---|---:|
| ranking-only | 10,000 | 123.089 ms | disabled | 100 |
| production-like | 5,000 | 660.39 ms | enabled | 100 |
| end-to-end-api | 1,000 | 10.338 ms | disabled | 100 |
| first-http-request-after-server-start | 100 | 1.362 ms | disabled | 100 |
| warm-http-request | 100 | 0.952 ms | disabled | 100 |

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
- A warm-up run is executed before measurement to avoid reporting one-time tokenizer startup cost as steady-state search latency.
- Deduplication is skipped when `dedupThreshold >= 1`, which is the expected benchmark and acceptance-test setting for measuring ranking rather than duplicate detection.

## Remaining Bottlenecks

- Token arrays still need to be normalized and counted into term-frequency maps during each search.
- Full result sorting is still used after scoring; a bounded top-K heap could reduce work for small `resultLimit` values.
- DB load is measured separately here, but production searches still parse `tokens_json` from SQLite rows into JavaScript arrays.

## Why This Matters

BM25 is only useful in the GUI if search latency stays predictable as the local-first card corpus grows. Separating benchmark stages makes future regressions easier to diagnose and makes the next optimization target clear.


## Candidate pipeline scopes

| Scope | Corpus | Elapsed | After dedup | Active |
|---|---:|---:|---:|---:|
| candidate-pipeline-near-duplicate | 200 | 8.323 ms | 1 | 1 |
| candidate-pipeline-diverse | 200 | 4.91 ms | 200 | 200 |