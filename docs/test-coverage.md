# Test Coverage

Last verified: 2026-07-31

## Commands

```bash
npm run typecheck
npm test
npm run acceptance:test
npm run test:e2e
npm run benchmark
npm run benchmark:http
npm run evaluate:search
npm run check:encoding
npm run verify
```

## Latest Results

| Command | Result |
|---|---:|
| `npm run typecheck` | passed |
| `npm test` | passed 36/36 |
| `npm run acceptance:test` | passed 59/59 |
| `npm run test:e2e` | passed 7/7 |
| `npm run benchmark` | passed: ranking-only, production-like, API, cold-start, warm-search |
| `npm run benchmark:http` | passed: HTTP cold-start and warm-search |
| `npm run evaluate:search` | passed: Precision@1 1.0, MRR 1.0, Recall@5 1.0, nDCG@5 1.0 |
| `npm run check:encoding` | passed |
| `npm audit --audit-level=high` | passed: 0 vulnerabilities |
| `docker build -t my-search-public:test .` | passed |
| `npm run verify` | passed |

## Covered Areas

- Card CRUD, archive/restore, bulk operations, imports, and Markdown export
- Normalized tags and directed links with derived backlinks
- KJ groups and graph rendering
- BM25 scoring, synonyms, time decay, deduplication, limits, and match metadata
- Candidate review, save, expiry, refresh, retention boundaries, score, and match reason
- SQLite foreign keys, migration reruns, rollback behavior, and legacy compatibility
- Request IDs, common error codes, validation, rate limits, and sensitive logging
- Core browser workflows and Japanese text handling
