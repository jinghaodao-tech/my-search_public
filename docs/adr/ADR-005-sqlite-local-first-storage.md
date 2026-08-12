# ADR-005: SQLite local-first storage

## Context
The portfolio app is a single-user local tool.
## Decision
Use SQLite with versioned migrations and local filesystem backup/restore scripts.
## Alternatives
PostgreSQL, Elasticsearch, hosted sync, or a vector database.
## Consequences
The app remains portable and works without cloud credentials.

## Estimates: SQLite vs. Elasticsearch at this scale

Measured on the current dataset: `data/cards.db` is 2,228,224 bytes for 233 `cards` rows (`card_tags`, `card_links`, and the `cards_fts` FTS5 index included in that file) — about 9.6 KB/row. Extrapolating linearly to the benchmark corpus sizes already used in `docs/benchmark.md` (10,000 rows) gives roughly 96 MB; at 100,000 rows, roughly 960 MB. SQLite has no separate process, no fixed memory floor beyond the OS file cache, and backs up as a single file (`scripts/backup.ts`).

Elasticsearch's fixed costs do not depend on data size: it runs as a separate JVM process with a commonly recommended minimum heap around 1–2 GB even for a small single-node index, plus its own on-disk index structures typically add roughly 10–30% over raw source size (general operational guidance, not something benchmarked against this dataset). At the corpus sizes above (hundreds to low hundred-thousands of rows), that fixed ~1–2 GB JVM floor alone would exceed the entire SQLite file size by 1–2 orders of magnitude, before counting cluster/node management overhead this single-user app has no use for.

This is why the fixed-overhead gap, not raw query speed, is the deciding factor at this scale: Elasticsearch's advantages start to matter at data and query volumes this app is not expected to reach.

## Evidence in code
`db/database.ts`, `db/migrate.ts`, `scripts/backup.ts`.
## Reversal condition
Reconsider for a clearly authorized multi-user deployment, or if corpus size approaches the range where SQLite's own benchmarked growth curve (see `docs/adr/ADR-018-no-inverted-index.md`) stops being negligible.
