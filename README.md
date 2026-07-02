# My Search App

[![CI](https://github.com/jingh/my-search-app_public/actions/workflows/ci.yml/badge.svg)](https://github.com/jingh/my-search-app_public/actions/workflows/ci.yml)

My Search App is a personal search and knowledge-management application. It combines card-style notes, BM25 search, tags, links between cards, a KJ-style grouping board, CSV/JSON import, and AI summaries.

For portfolio purposes, the project focuses not only on application features but also on backend engineering practices. The app was migrated from JSON file storage to SQLite, search-related token data is persisted to improve search performance, and the main API paths now include request validation, security headers, CORS configuration, rate limiting, API tests, and CI checks.

## Features

- Create, edit, delete, archive, and restore card-style notes
- Search cards with BM25 scoring
- Organize cards with tags
- Connect related cards with bidirectional links and backlinks
- Group cards on a KJ-style board
- Import cards from CSV and JSON
- Generate AI summaries with Anthropic or Gemini
- Run locally or with Docker Compose
- Run type checks, API tests, and dependency audit in GitHub Actions

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

The API has also been improved as a backend portfolio project. Card creation/update, bulk operations, imports, links, AI summary, and KJ group APIs now validate request bodies before application logic is executed.

## Security and API Quality

This project adds request validation, rate limiting, security headers, and CI checks around the main API paths. These measures are not meant to claim complete security coverage for every possible scenario. The goal is to show practical backend quality improvements for the most important and higher-risk endpoints.

- **Zod validation**: Card creation/update, bulk operations, imports, links, AI summary, and KJ group APIs validate request bodies with Zod before executing application logic. Invalid types, empty strings, oversized input, malformed URLs, unexpected fields, and invalid ID lists are rejected at the API layer.
- **Helmet**: Helmet is used to set common HTTP security headers.
- **CORS**: CORS is not hard-coded as fully open. Allowed origins can be configured with `CORS_ORIGIN`.
- **Rate limiting**: AI summary and import-related APIs are protected with rate limits to reduce abuse, excessive load, and external API cost risks.
- **Error handling**: Validation errors return consistent `400` responses in the form `{ "error": "Invalid request", "details": ... }`.
- **Dependency audit**: CI runs `npm audit --audit-level=high` to detect known high-severity vulnerabilities in npm dependencies.
- **Testing**: API tests cover both normal and invalid request cases.
- **DB path**: `DB_PATH` allows local and Docker environments to use different database paths.

## CI / Testing

GitHub Actions runs the following commands on push and pull request to `main`.

```bash
npm ci
npm run typecheck
npm test
npm audit --audit-level=high
```

The API test suite currently covers:

- successful card creation
- validation errors for empty title and oversized body
- `404` for missing card IDs
- invalid bulk operation payloads
- rejecting self-links
- invalid CSV / JSON import requests
- rate limiting on import-related APIs

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
```

## Local Setup

Requirements:

- Node.js 24 or compatible version
- npm

Install dependencies:

```bash
npm ci
```

Run checks:

```bash
npm run typecheck
npm test
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

## API Overview

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
- Implemented BM25 search over card title, body, and tags
- Improved search performance by persisting token data and document length at save time
- Added Zod validation to reject invalid request bodies before business logic runs
- Added rate limits to AI summary and import APIs, where cost and load risks are higher
- Separated Express `app` export from server `listen` to make API tests easier
- Added `DB_PATH` so local and Docker environments can use different SQLite paths
- Automated type checks, API tests, and high-severity dependency audit in GitHub Actions

## Roadmap

- Split API routes and service logic into smaller modules
- Add OpenAPI documentation or a lightweight API specification
- Add authentication and authorization
- Extend Zod validation to GET query parameters
- Add preview or dry-run support for import operations
- Improve search result highlighting and ranking explanations
- Add a CI job that verifies Docker build

## Notes on Native Dependencies

This project uses `better-sqlite3`, which includes native bindings. If CI fails during install, likely causes include Node.js version compatibility, missing prebuilt binaries, or native build tooling. Practical mitigations are to pin a stable Node.js version, update `better-sqlite3` to a compatible version, or install the required build tools in CI.
