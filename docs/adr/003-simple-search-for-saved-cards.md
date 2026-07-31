# ADR-003: Simple search for saved cards

## Context
Saved cards are a smaller, durable corpus and need predictable list filtering.
## Decision
Keep `GET /api/cards?q=...` as SQLite `LIKE` filtering and keep BM25 in `POST /api/run`.
## Alternatives
Force BM25 across both workflows or add FTS5 immediately.
## Consequences
The UI communicates two distinct search jobs without hiding implementation details.
## Evidence in code
`repositories/cards_repository.ts`, `docs/api.md`.
## Reversal condition
Reconsider when measured saved-card scale requires indexed full-text search.
