# BM25 Benchmark (Japanese Notes)

`npm run benchmark` reports separate scopes:

- ranking-only: precomputed tokens and BM25 scoring
- production-like: deduplication, score filtering, and result limits
- end-to-end-api: database load plus the search pipeline
- cold-start: first execution
- warm-search: steady-state execution after warm-up

Corpus sizes are 100, 1,000, 5,000, and 10,000 items. Results vary by machine, so generated values include their measurement conditions.

For an actual HTTP route measurement, run `npm run benchmark:http`. It measures `GET /api/cards` cold-start and warm-search timings separately.