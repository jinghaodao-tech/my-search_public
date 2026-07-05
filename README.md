# My Search App

[![CI](https://github.com/jinghaodao-tech/my-search_public/actions/workflows/ci.yml/badge.svg)](https://github.com/jinghaodao-tech/my-search_public/actions/workflows/ci.yml)

## Demo

https://github.com/user-attachments/assets/be5052d8-1d60-4aaa-8f6a-565dbaa1ee4d

My Search App is a local-first knowledge management app built around BM25 search, SQLite persistence, and portfolio-grade backend quality. It supports card-style notes, tags, backlinks, KJ grouping, CSV/JSON import, and AI summaries while keeping data local by default.

The project highlights practical engineering improvements: migration from JSON files to SQLite, persisted BM25 token data for faster search, API validation with Zod, endpoint tests with Vitest / Supertest, and reproducible operation through Docker and CI.

## Features

- Create, edit, delete, archive, and restore card-style notes
- Search cards with BM25 scoring
- Organize cards with tags
- Connect related cards with bidirectional links and backlinks
- Group cards on a KJ-style board
- Import cards from CSV and JSON
- Generate AI summaries with Anthropic or Gemini
- Run locally or with Docker Compose
- Run type checks, API tests, and high-severity dependency audit in GitHub Actions

## Tech Stack

| Area | Technologies |
|---|---|
| Backend | Node.js, TypeScript, Express |
| Database | SQLite, better-sqlite3 |
| Search | BM25, persisted token data |
| Validation / Security | Zod, Helmet, CORS, express-rate-limit |
| Testing | Vitest, Supertest |
| DevOps | Docker, Docker Compose, GitHub Actions |
| Frontend | HTML, CSS, JavaScript |
| AI | Anthropic API, Gemini API |

## Project Background

The first version stored card data in a JSON file. That approach was simple, but it made full-file reads and bulk updates more expensive as the data grew. The storage layer was migrated to SQLite while keeping the existing card CRUD behavior.

Search is implemented with BM25. Instead of tokenizing card content on every search request, token data and document length are generated when cards are saved and then persisted in SQLite. This reduces repeated preprocessing work during search.

### BM25 Performance Before / After

The search pipeline was changed from tokenizing every card during each search to precomputing `tokens_json` and `doc_length` when cards are saved. Those precomputed values are persisted in SQLite and reused by BM25 scoring.

| Stage | Before | After |
|---|---:|---:|
| Load cards | 2.175 ms | 7.054 ms |
| Tokenize | 4.584 s | 0.464 ms |
| Score | 4.705 s | 40.778 ms |
| Total BM25 | 9.705 s | 1.413 s |

The largest improvement came from removing per-search morphological tokenization from the hot path. BM25 still takes 1.413 seconds overall, so database access, aggregation, and sorting are the next likely bottleneck candidates.

The API has also been improved as a backend portfolio project. Card creation/update, bulk operations, imports, links, AI summary, KJ group, collect, scheduler, and BM25 run APIs now validate request bodies before application logic is executed. The Express app is exported separately from the server startup code so the API can be tested directly with Supertest.

## Security and API Quality

This project adds request validation, rate limiting, security headers, and CI checks around the main API paths. These measures are not meant to claim complete security coverage for every possible scenario. The goal is to show practical backend quality improvements for the most important and higher-risk endpoints.

- **Zod validation**: Card creation/update, bulk operations, imports, links, AI summary, KJ group, collect, scheduler, and BM25 run APIs validate request bodies with Zod before executing application logic. Invalid types, empty strings, oversized input, malformed URLs, unexpected fields, and invalid ID lists are rejected at the API layer.
- **Helmet**: Helmet is used to set common HTTP security headers.
- **CORS**: CORS is not hard-coded as fully open. Allowed origins can be configured with `CORS_ORIGIN`.
- **Rate limiting**: AI summary and import-related APIs are protected with rate limits to reduce abuse, excessive load, and external API cost risks.
- **Error handling**: Validation errors return consistent `400` responses in the form `{ "error": "Invalid request", "details": ... }`.
- **Dependency audit**: CI runs `npm audit --audit-level=high` to detect known high-severity vulnerabilities in npm dependencies.
- **Testing**: API tests cover both normal and invalid request cases.
- **DB path**: `DB_PATH` allows local and Docker environments to use different database paths.

In other words, the project does not claim that every API is fully secured. It shows that the main API paths have been improved with validation, security headers, rate limits, tests, and CI checks.

## CI / Testing

GitHub Actions runs the following commands on push and pull request to `main`.

```bash
npm ci
npm run typecheck
npm test
npm audit --audit-level=high
docker build -t my-search-public:test .
```

The API test suite currently covers:

- successful card creation
- validation errors for empty title and oversized body
- `404` for missing card IDs
- invalid bulk operation payloads
- rejecting self-links
- invalid CSV / JSON import requests
- rate limiting on import-related APIs
- database write paths such as card updates, bulk archive/restore/delete, and bidirectional link cleanup

## Operations

The project includes small operational scripts for local-first development and portfolio demonstrations. CLI-based local backup and restore scripts are provided for copying and restoring the SQLite database used by the local-first app.

```bash
npm run seed:demo
npm run export:json
npm run export:sqlite
npm run backup
npm run restore -- backups/cards-YYYY-MM-DDTHH-MM-SS-000Z.db
npm run db:migrate
npm run migrate:kj-groups
npm run benchmark
```

The server also exposes `GET /healthz` for a lightweight application and SQLite health check, and request logs are emitted as JSON with an `X-Request-Id` so they can be filtered more easily in Docker or CI logs. The project includes minimal SQLite migration tracking for local development and future schema changes.

## Environment Variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `PORT` | No | `3000` | Express server port |
| `DB_PATH` | No | `data/cards.db` | SQLite database path |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Allowed CORS origin |
| `AI_PROVIDER` | No | `anthropic` | AI summary provider, such as `anthropic` or `gemini` |
| `ANTHROPIC_API_KEY` | Only for Anthropic summaries | - | Anthropic API key |
| `ANTHROPIC_MODEL` | No | app default | Anthropic model name |
| `GEMINI_API_KEY` | Only for Gemini summaries | - | Gemini API key |
| `GEMINI_MODEL` | No | app default | Gemini model name |
| `MOCK_AI_SUMMARY` | No | `false` | Use mock summary output for tests or local verification |
| `AI_RATE_LIMIT` | No | `10` | Requests per minute for AI summary endpoints |
| `IMPORT_RATE_LIMIT` | No | `10` | Requests per minute for CSV/JSON import endpoints |
| `API_RATE_LIMIT` | No | `60` | Requests per minute for collect-related endpoints |

Example `.env`:

```env
PORT=3000
DB_PATH=data/cards.db
CORS_ORIGIN=http://localhost:3000

AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_api_key
GEMINI_API_KEY=

AI_RATE_LIMIT=10
IMPORT_RATE_LIMIT=10
API_RATE_LIMIT=60
```

`.env` is intentionally not committed to Git. `.env.example` is committed as a public template, and real API keys should only be stored in local or deployment-specific environment variables. Docker Compose can use a different `DB_PATH` so the container database is stored under `/app/data`.

## Local Setup

Requirements:

- Node.js 24 or compatible version
- npm

Install dependencies:

```bash
git clone https://github.com/jinghaodao-tech/my-search_public.git
cd my-search_public
cp .env.example .env
npm ci
```

Run checks:

```bash
npm run typecheck
npm test
npm audit --audit-level=high
```

Start the app:

```bash
npm start
```

Open the app:

```text
http://localhost:3000
```

For local development with file watching:

```bash
npm run dev
```

## Docker Setup

Docker Compose sets `DB_PATH=/app/data/cards.db` and mounts `./data` into the container, so the SQLite database can persist outside the container.

```bash
docker compose up --build
```

Open the app:

```text
http://localhost:3000
```

## Database Design

The main card data is stored in SQLite. `tokens_json` and `doc_length` are precomputed BM25 data generated when cards are saved, so search can skip repeated tokenization work.

| Column | Purpose |
|---|---|
| `id` | Primary card identifier |
| `title` | Card title |
| `body` | Main card content |
| `summary` | Optional AI-generated summary |
| `url` | Optional source URL |
| `type` | Card type such as `memo`, `csv`, or `article` |
| `color` | Optional UI color |
| `tags_json` | JSON-encoded tag list |
| `links_json` | JSON-encoded Zettelkasten card links |
| `kj_group_id` | Optional KJ group assignment |
| `archived` | Archive flag |
| `archived_at` | Archive timestamp |
| `tokens_json` | JSON-encoded tokens precomputed for BM25 search |
| `doc_length` | Precomputed token count used by BM25 scoring |
| `created_at` | Creation timestamp |
| `updated_at` | Last update timestamp |

KJ groups are also stored in SQLite so card persistence and grouping persistence use the same storage layer.

| Column | Purpose |
|---|---|
| `id` | Primary KJ group identifier |
| `name` | Group name |
| `color` | UI color |
| `description` | Optional description |
| `created_at` | Creation timestamp |
| `updated_at` | Last update timestamp |

Current indexes:

| Index | Table | Purpose |
|---|---|---|
| `idx_cards_title` | `cards` | Speeds up title-oriented lookups |
| `idx_cards_type` | `cards` | Speeds up type filtering |
| `idx_cards_created_at` | `cards` | Supports recency ordering |
| `idx_cards_kj_group_id` | `cards` | Speeds up KJ group assignment lookup |
| `idx_kj_groups_created_at` | `kj_groups` | Supports stable KJ group ordering |

## API Overview

For detailed request / response examples, see [docs/api.md](docs/api.md).

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/cards` | List and filter cards |
| `POST` | `/api/cards` | Create a card |
| `GET` | `/api/cards/:id` | Get a card with backlinks |
| `PUT` | `/api/cards/:id` | Update a card |
| `DELETE` | `/api/cards/:id` | Delete a card |
| `POST` | `/api/cards/bulk-archive` | Archive multiple cards |
| `POST` | `/api/cards/bulk-restore` | Restore multiple cards |
| `POST` | `/api/cards/bulk-delete` | Delete multiple cards |
| `POST` | `/api/cards/:id/summarize` | Generate AI summary |
| `POST` | `/api/cards/summarize-bulk` | Start bulk AI summary |
| `POST` | `/api/cards/import-csv` | Import cards from CSV |
| `POST` | `/api/cards/import-json` | Import cards from JSON |
| `POST` | `/api/cards/:id/links` | Add card link |
| `DELETE` | `/api/cards/:id/links/:targetId` | Remove card link |
| `GET` | `/api/zettelkasten/graph` | Get graph data |
| `GET` | `/api/kj/groups` | List KJ groups |
| `POST` | `/api/kj/groups` | Create KJ group |
| `PUT` | `/api/kj/groups/:id` | Update KJ group |
| `DELETE` | `/api/kj/groups/:id` | Delete KJ group |
| `POST` | `/api/kj/groups/:id/cards` | Assign card to KJ group |

## Technical Outcomes

- Migrated persistence from JSON file storage to SQLite
- Implemented BM25-based search for keyword retrieval over card title, body, and tags
- Added search result highlighting and match explanations to show why each result matched the query
- Improved search performance by persisting token data and document length at save time
- Replaced full card-table rewrites with targeted SQLite writes for common card CRUD, bulk, link, and KJ assignment operations
- Moved KJ group persistence from JSON file storage to SQLite so cards and groups share the same persistence layer
- Added Zod validation to reject invalid request bodies before business logic runs
- Added rate limits to expensive or abuse-prone endpoints such as AI summary and import APIs
- Added Helmet and configurable CORS for basic Web security hardening
- Added Docker support to make the runtime environment reproducible
- Separated Express `app` export from server `listen` to make API tests easier
- Added `DB_PATH` so local and Docker environments can use different SQLite paths
- Automated type checks, API tests, high-severity dependency audit, and Docker image build checks in GitHub Actions

## Future Improvements

- Add authentication and authorization for multi-user usage
- Add more API tests for edge cases and error handling
- Improve logging for production-like operation
- Add OpenAPI documentation or a lightweight API specification

## Notes on Native Dependencies

This project uses `better-sqlite3`, which includes native bindings. If CI fails during install, likely causes include Node.js version compatibility, missing prebuilt binaries, or native build tooling. Practical mitigations are to pin a stable Node.js version, update `better-sqlite3` to a compatible version, or install the required build tools in CI.
---

## Acceptance Test Results

Last verified: 2026-07-05

Command:

```bash
npm run acceptance:test
```

Result: passed 22/22

- BM25 search: exact and partial matches rank above unrelated cards.
- BM25 search: empty and missing queries do not crash.
- BM25 search: result count stays within `resultLimit`.
- BM25 search: weighted keywords have stronger score impact than normal keywords.
- BM25 search: synonyms are reflected in search results.
- Zettelkasten graph: isolated cards are not included in nodes.
- Card CRUD: create, read, update, and delete work correctly.
- Archive / Restore: archived state changes correctly.
- Bulk Archive: multiple cards can be archived together.
- Bulk Delete: multiple cards can be deleted together.
- Tag operations: tag add, remove, and search work correctly.
- CSV Import: valid CSV can be imported.
- JSON Import: valid JSON can be imported.
- Import error handling: invalid input does not crash the server.
- KJ groups: create, update, assign, and delete work correctly.
- Backlinks: a B-side source can be read after linking A to B.
- Search ranking: keyword weights and synonyms affect scores.
- Performance: search stays under the threshold for the tested corpus size.
- API validation: invalid IDs and empty bodies return appropriate errors.
- DB migration: count and key fields are preserved after JSON to SQLite migration.
- KJ group migration: schema, indexes, JSON migration, and card group references are verified.
