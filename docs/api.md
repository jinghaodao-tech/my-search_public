# API Notes

This document summarizes the main local API endpoints used by the app. It is intentionally lightweight; the project can add OpenAPI later if the API surface grows further.

## Health

### `GET /healthz`

Checks that the Express app can reach SQLite.

Successful response:

```json
{
  "ok": true,
  "status": "healthy",
  "db": "ok",
  "cardCount": 12,
  "uptimeSec": 10.4,
  "checkedAt": "2026-07-04T00:00:00.000Z"
}
```

Failure response:

```json
{
  "ok": false,
  "status": "unhealthy",
  "db": "error",
  "checkedAt": "2026-07-04T00:00:00.000Z"
}
```

## Cards

### `GET /api/cards`

Lists cards. Without pagination parameters, this endpoint keeps the legacy response shape and returns an array of cards.

Query parameters:

- `archived`: `true` or `false`
- `tag`: tag filter backed by `card_tags`
- `type`: `memo`, `article`, or `csv`
- `q`: simple SQL `LIKE` filter over title, body, summary, and tags. This is not BM25 ranking.
- `kjGroupId`: KJ group filter
- `limit`: enables paged response, default `20`, max `100`
- `offset`: zero-based start position, default `0`
- `sort`: `created_at_desc` or `created_at_asc`

Backward compatibility:

- Without `limit` or `offset`, the response is the legacy card array.
- With `limit` or `offset`, the response is paged:

```json
{
  "items": [],
  "total": 123,
  "limit": 20,
  "offset": 0
}
```

BM25 ranking search remains handled by `POST /api/run` and the existing search pipeline.

### `POST /api/cards`

Creates a card. Request bodies are validated with Zod.

```json
{
  "title": "SQLite migration notes",
  "body": "Moved persistence from JSON to SQLite.",
  "tags": ["sqlite", "backend"],
  "type": "memo"
}
```

### `PUT /api/cards/:id`

Updates a card.

### `DELETE /api/cards/:id`

Deletes a card and removes backlinks from other cards.

## Import / Export

### `POST /api/cards/import-csv`

Imports cards from CSV text. Protected by import rate limits.

### `POST /api/cards/import-json`

Imports cards from JSON text. Protected by import rate limits.

Operational exports are available as npm scripts:

```bash
npm run export:json
npm run export:sqlite
```

## Search

### `POST /api/run`

Runs the BM25 scoring pipeline.

Search results include compatibility-preserving match metadata:

```json
{
  "matchedFields": ["title", "body", "tags"],
  "matchedKeywords": ["SQLite"]
}
```

## Operations CLI

```bash
npm run seed:demo
npm run backup
npm run restore -- backups/cards-2026-07-04T00-00-00-000Z.db
npm run db:migrate
npm run benchmark
```

Backup and restore are CLI scripts, not HTTP APIs. They copy and restore the SQLite database used by the local-first app. The project includes minimal SQLite migration tracking for local development and future schema changes.
## Candidate lifecycle

Candidate state is separate from saved-card archive state:

- `GET /api/candidates?status=unreviewed|reviewed_not_saved|saved_as_card|expired` returns candidate lifecycle and source article metadata.\n- `GET /api/candidates/:id` returns one candidate lifecycle. Candidate records also expose the latest BM25 `score` and `matchReason` when `/api/run` has ranked that article.
- `PUT /api/candidates/:id/review` marks a candidate as reviewed but not saved.
- `POST /api/candidates/:id/save` creates an article card and marks the candidate as `saved_as_card`.
- `PUT /api/candidates/:id/expire` expires a candidate without deleting the source article.
- `POST /api/candidates/expire-reviewed` expires old `reviewed_not_saved` candidates. The default candidate retention is 14 days and is supplied as `candidateRetentionDays`.

Saved-card search remains separate: `GET /api/cards?q=...` uses SQLite `LIKE` filtering over saved-card fields, while `POST /api/run` executes the BM25 collection pipeline.

API errors include a stable code field such as validation_failed, card_not_found, candidate_not_found, candidate_already_saved, and candidate_expired; X-Request-Id is included for correlation.