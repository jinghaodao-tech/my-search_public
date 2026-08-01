# BM25 Benchmark (Japanese Notes)

`npm run benchmark` reports separate scopes:

- ranking-only: precomputed tokens and BM25 scoring
- production-like: deduplication, score filtering, and result limits
- end-to-end-pipeline: pipeline execution measured separately from ranking-only
- first-pipeline-call: first pipeline execution without global warmup
- repeated-pipeline-call: repeated execution after an excluded local warmup

Corpus sizes are 100, 1,000, 5,000, and 10,000 items. Results vary by machine, so generated values include their measurement conditions.

For an actual HTTP route measurement, run `npm run benchmark:http`. It measures `GET /api/cards` first-http-request-after-server-start and warm-http-request timings separately.