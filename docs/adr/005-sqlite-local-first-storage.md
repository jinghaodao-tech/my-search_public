# ADR-005: SQLite local-first storage

## Context
The portfolio app is a single-user local tool.
## Decision
Use SQLite with versioned migrations and local filesystem backup/restore scripts.
## Alternatives
PostgreSQL, Elasticsearch, hosted sync, or a vector database.
## Consequences
The app remains portable and works without cloud credentials.
## Evidence in code
`db/database.ts`, `db/migrate.ts`, `scripts/backup.ts`.
## Reversal condition
Reconsider for a clearly authorized multi-user deployment.
