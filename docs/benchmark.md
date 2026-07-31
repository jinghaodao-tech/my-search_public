# BM25 Benchmark

Generated: 2026-07-31T11:06:52.886Z

Command:

```bash
npm run benchmark
```

The benchmark uses deterministic synthetic card corpora with precomputed `tokens` and `docLength`, matching the production SQLite design where `tokens_json` and `doc_length` are generated on write instead of tokenizing every card during search.

The script performs one 100-card warm-up search before recording results. This excludes first-run tokenizer initialization and JavaScript runtime warm-up from the measured rows.

## Results

| Corpus size | DB load | Token parse / preparation | BM25 scoring | Sorting / limiting | Total search | Returned |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 2.186 ms | 1.915 ms | 1.487 ms | 0.16 ms | 5.262 ms | 100 |
| 1,000 | 1.437 ms | 4.061 ms | 9.674 ms | 0.678 ms | 16.364 ms | 100 |
| 5,000 | 1.01 ms | 9.77 ms | 50.096 ms | 4.746 ms | 68.974 ms | 100 |
| 10,000 | 3.03 ms | 25.231 ms | 57.955 ms | 7.118 ms | 100.18 ms | 100 |

## Scope Results

| Scope | Corpus | Elapsed | Dedup | Result limit |
|---|---:|---:|---|---:|
| ranking-only | 10,000 | 90.158 ms | disabled | 100 |
| production-like | 5,000 | 590.685 ms | enabled | 100 |
| end-to-end-api | 1,000 | 8.242 ms | disabled | 100 |
| cold-start | 100 | 1.835 ms | disabled | 100 |
| warm-search | 100 | 1.681 ms | disabled | 100 |

## End-to-end HTTP

Run `npm run benchmark:http` to measure an actual `GET /api/cards` route with cold-start and warm-search timings. This is kept separate from the deterministic ranking corpus table.

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
| candidate-pipeline-near-duplicate | 200 | 7.271 ms | 1 | 1 |
| candidate-pipeline-diverse | 200 | 3.92 ms | 200 | 200 |