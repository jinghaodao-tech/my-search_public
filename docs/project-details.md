# Project Details

This document keeps the longer project notes out of the README so the repository front page stays short.

## Project Background

The first version stored card data in JSON files. That was simple, but full-file reads and rewrites became less suitable as the data grew. The storage layer was moved to SQLite while preserving the existing card API shape.

Search uses BM25. Instead of tokenizing all card content on every search, cards and collected articles persist `tokens_json` and `doc_length` when saved. Search can then reuse precomputed token data.

## Database Design

Main tables:

| Table | Purpose |
|---|---|
| `cards` | Card content, archive state, KJ group assignment, and BM25 precomputed token data |
| `articles` | Collected RSS/arXiv/GitHub articles, URL de-duplication metadata, and BM25 token cache |
| `card_tags` | Junction table for card-tag relationships |
| `card_links` | Junction table for directed Zettelkasten links and backlinks |
| `kj_groups` | KJ grouping metadata |
| `schema_migrations` | Local migration tracking |
| `jobs` | Persisted background job state and results |
| `cards_fts` | SQLite FTS5 index used by the optional hybrid search engine |

PostgreSQL preparation is available through `repositories/postgres_repository.ts`, `db/postgres_schema.sql`, and `npm run db:migrate:postgres`; SQLite remains the active default driver until service-level cutover.

`tags_json` and `links_json` remain on `cards` as compatibility cache columns for older data paths, but normalized reads/writes use `card_tags` and `card_links`.

### BM25 Engine and Demo Separation

The BM25 engine file is kept focused on reusable search logic. Manual sample data and demonstration output live in `scripts/demo_bm25.ts`, so production imports do not carry demo fixtures or direct console output.

### `loadCards()` and `getCards()` Design

Earlier versions loaded all cards, hydrated every tag/link relation, and then filtered and sorted in JavaScript. Card listing now pushes `archived`, `type`, `kjGroupId`, `tag`, simple `q`, recency ordering, `limit`, and `offset` into SQLite. Tag filtering uses the `card_tags` junction table, and `q` is a simple SQL `LIKE` filter over title, body, summary, and tags.

When `GET /api/cards` receives `limit` or `offset`, it returns a paged object with `items`, `total`, `limit`, and `offset`. Without those parameters it keeps the legacy array response for existing UI compatibility. The paged path hydrates tags and links only for the selected card rows, reducing unnecessary relation loading during list views.

This list filter remains a lightweight card-list narrowing tool. The search endpoint can use `SEARCH_ENGINE=hybrid` to combine BM25 ranking with SQLite FTS5 evidence; `q` filtering remains independently configurable through `CARD_SEARCH_ENGINE`.

Important indexes:

| Index | Table | Purpose |
|---|---|---|
| `idx_cards_title` | `cards` | Title lookup |
| `idx_cards_type` | `cards` | Type filtering |
| `idx_cards_created_at` | `cards` | Recency ordering |
| `idx_cards_kj_group_id` | `cards` | KJ group lookup |
| `idx_card_tags_tag` | `card_tags` | Tag filtering and tag cloud aggregation |
| `idx_card_links_source` | `card_links` | Outgoing link lookup |
| `idx_card_links_target` | `card_links` | Backlink lookup |
| `idx_kj_groups_created_at` | `kj_groups` | Stable KJ group ordering |
| `idx_articles_url_unique` | `articles` | Prevent duplicate collected URLs |
| `idx_articles_published_at` | `articles` | Recency ordering for collected articles |
| `idx_articles_source` | `articles` | Source filtering and reporting |
| `idx_articles_doc_length` | `articles` | BM25 token cache inspection |
| `idx_articles_content_hash` | `articles` | Reuse tokenized content when title/body are unchanged |

## Collected Article Persistence

Collected articles used to be stored in `data/articles.json`. They now use the same SQLite database as cards, which keeps the local-first design while making article data easier to query, deduplicate, migrate, and back up.

The `articles` table stores URL uniqueness, source metadata, publish time, tags, `tokens_json`, `doc_length`, and `content_hash`. During collection, unchanged article title/body pairs reuse the existing token cache; only new or changed content is tokenized again.

To migrate an existing local JSON article cache:

```bash
npm run migrate:articles
```

The migration is idempotent: missing JSON exits safely, repeated runs upsert the same articles, and duplicate URLs are skipped without corrupting existing rows.

## API Overview

For detailed request and response examples, see [api.md](api.md).

Core endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/cards` | List and filter cards |
| `POST` | `/api/cards` | Create a card |
| `GET` | `/api/cards/:id` | Get a card with backlinks |
| `PUT` | `/api/cards/:id` | Update a card |
| `DELETE` | `/api/cards/:id` | Delete a card |
| `POST` | `/api/cards/bulk-archive` | Bulk archive cards |
| `POST` | `/api/cards/bulk-restore` | Bulk restore cards |
| `POST` | `/api/cards/bulk-delete` | Bulk delete cards |
| `GET` | `/api/cards/:id/export-md` | Export one card as Markdown |
| `POST` | `/api/cards/export-md-bulk` | Export selected cards as Markdown zip |
| `POST` | `/api/cards/:id/links` | Link cards |
| `DELETE` | `/api/cards/:id/links/:targetId` | Unlink cards |
| `GET` | `/api/zettelkasten/graph` | Get graph data |
| `GET` | `/api/kj/groups` | List KJ groups |
| `POST` | `/api/kj/groups` | Create KJ group |

`POST /api/cards/archive-bulk` remains as a compatibility alias and returns `Deprecation: true`. New clients should use `/api/cards/bulk-archive`.

## Security and API Quality

- Zod validates core request bodies before application logic runs.
- Helmet sets common HTTP security headers.
- CORS uses configurable `CORS_ORIGIN`.
- AI and import endpoints use rate limits.
- Validation, 404, and 500 responses include request IDs.
- Logs are structured JSON and avoid API keys, cookies, authorization headers, AI prompt text, and card body content.

See [logging.md](logging.md) for logging and error observability details.

## CI and Testing

GitHub Actions runs type checks, API tests, audit, Docker build, and E2E tests.

```bash
npm run typecheck
npm test
npm run acceptance:test
npm run test:e2e
```

Current detailed coverage is listed in [test-coverage.md](test-coverage.md).

## Operations

Useful local commands:

```bash
npm start
npm run dev
npm run benchmark
npm run backup
npm run restore -- backups/cards-YYYY-MM-DDTHH-MM-SS-000Z.db
npm run db:migrate
npm run migrate:articles
npm run migrate:kj-groups
```

The server exposes `GET /healthz` for a lightweight app and SQLite health check.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express server port |
| `DB_PATH` | `data/cards.db` | SQLite database path |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin |
| CANDIDATE_RETENTION_DAYS | 14 | Days to retain reviewed-but-unsaved candidates |
| `AI_PROVIDER` | `anthropic` | `anthropic` or `gemini` |
| `ANTHROPIC_API_KEY` | - | Anthropic API key |
| `ANTHROPIC_MODEL` | app default | Anthropic model |
| `GEMINI_API_KEY` | - | Gemini API key |
| `GEMINI_MODEL` | app default | Gemini model |
| `MOCK_AI_SUMMARY` | `false` | Use mock summaries |
| `AI_RATE_LIMIT` | `10` | AI requests per minute |
| `IMPORT_RATE_LIMIT` | `10` | Import requests per minute |
| `API_RATE_LIMIT` | `60` | Collect-related requests per minute |

## Local Setup

```bash
npm install
npm run typecheck
npm test
npm start
```

Then open `http://localhost:3000`. The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only when explicitly exposing it on a trusted network. CORS controls browser origins but is not authentication. The Zettelkasten graph is bundled locally at `public/vendor/vis-network.min.js`, so the core UI does not depend on a CDN.

## Docker Setup

```bash
docker compose up --build
```

## Technical Outcomes

- Migrated persistence from JSON files to SQLite.
- Added normalized junction tables for tags and Zettelkasten links.
- Persisted BM25 token data and document length at save time.
- Added API validation, structured logging, request IDs, and rate limits.
- Added Markdown export for portability and backup.
- Added Vitest / Supertest / Playwright coverage and GitHub Actions CI.

## Future Improvements

- Add authentication and authorization for multi-user usage.
- Add OpenAPI documentation.
- Add external metrics/tracing for production-style observability.
- Continue splitting large route/controller modules.

## Notes on Native Dependencies

This project uses `better-sqlite3`, which includes native bindings. If CI fails during install, likely causes include Node.js version compatibility, missing prebuilt binaries, or native build tooling.
