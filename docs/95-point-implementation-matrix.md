# 95-point implementation matrix

Compared with My_Search_App_95_point_system_refactor_prompt.md on 2026-07-31.

| Area | Status | Evidence |
|---|---|---|
| Local-first SQLite and localhost default | Done | db/database.ts, server.ts |
| Two-stage candidate ranking and saved-card search | Done | routes/search_routes.ts, repositories/cards_repository.ts |
| Candidate lifecycle and retention | Done | repositories/candidates_repository.ts |
| Candidate to card one-to-one relation | Done | migration 009/010, saved_card_id unique index |
| Atomic candidate save | Done | createCardWithTransaction, candidate save tests |
| Candidate timestamps | Done | articles repository and lifecycle tests |
| Browser non-2xx handling | Done | public/app.js, public/js/cards_ui.js |
| Error code contract | Done | services/http_service.ts and route tests |
| BM25 validation bounds | Done | schemas/api_schemas.ts |
| BM25 belowThreshold naming | Done | bm25_engine.ts |
| Near-duplicate and diverse benchmarks | Done | scripts/benchmark.ts |
| Candidate API and saved-card HTTP benchmarks | Done | scripts/benchmark_http.ts |
| Cold-start and warm-request benchmarks | Done | scripts/benchmark_http.ts |
| Benchmark performance gates | Done | benchmark artifacts and thresholds |
| Search quality dataset | Done | 50 documents, 11 cases, v4 artifact |
| Search quality CI gate | Done | scripts/evaluate_search_quality.ts |
| Fixture collection | Done | POST /api/collect fixture portfolio-demo |
| Full browser E2E without direct article INSERT | Done | e2e/core-flows.spec.ts |
| Migration source of truth | Done | db/migrate.ts |
| Schema integrity verification | Done | scripts/verify_schema.ts |
| Normalized tags and directed links | Done | relation repositories and integrity tests |
| Card write transactions | Done | cards repository transactions |
| Deprecated archive route | Done | Deprecation header and shared bulk service |
| CI artifact upload | Done | .github/workflows/ci.yml |
| 15-minute demo and docs | Done | docs/demo-15min.md |
| Docker and dependency audit | Done | verify scripts |

## Remaining external-state item

GitHub Actions workflow success and run URL require a remote push, which the repository rules explicitly leave to the user.
