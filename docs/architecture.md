# Architecture

My Search App is a local-first application with four explicit boundaries:

- `routes/`: HTTP transport, validation, status codes, and request IDs.
- `services/`: use cases and orchestration such as card lifecycle, collection, jobs, and AI helpers.
- `repositories/`: SQLite persistence and relation maintenance.
- `domain/` and `search/`: stable business types and replaceable search/tokenization implementations.

The search boundary is `SearchEngine`. `Bm25SearchEngine` is selected by `SEARCH_ENGINE=bm25`; `HybridSearchEngine` is selected by `SEARCH_ENGINE=hybrid` and combines normalized BM25 and SQLite FTS5 evidence without changing route contracts.

The frontend API boundary now has a typed TypeScript client in `frontend/api_client.ts`, built with `npm run build:frontend`. Existing UI modules remain compatible during the incremental migration.

The repository boundary also includes `PostgresRepository`. SQLite remains the default application driver. The PostgreSQL adapter and schema migration CLI are available for the database migration phase: set `POSTGRES_URL`, run `npm run db:migrate:postgres`, then wire service repositories to `PostgresRepository` as part of deployment-specific cutover.

Background collection returns a job ID from `POST /api/collect` when `background: true`. Poll `GET /api/jobs/:id` for `queued`, `running`, `succeeded`, or `failed` status. Job state is persisted in the local SQLite database and survives process restarts; execution itself remains single-process.

The public API contract is maintained in [openapi.yaml](openapi.yaml). Migrations remain the source of truth for SQLite schema changes.

Set `API_KEY` to require the `X-API-Key` header on API requests. Leaving it unset preserves local development behavior.
