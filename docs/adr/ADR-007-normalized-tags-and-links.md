# ADR-007: Normalized tags and links

## Context
JSON arrays were difficult to query and clean up consistently.
## Decision
Use `card_tags` and directed `card_links` tables with foreign keys and compatibility fields.
## Alternatives
Keep relation arrays only, or use undirected links.
## Consequences
Backlinks, deletion cleanup, and integrity checks are explicit.
## Evidence in code
`db/migrate.ts`, `repositories/card_links_repository.ts`.
## Reversal condition
Reconsider only if the data model changes to a graph-native store.


Link semantics: card_links stores a directed source-to-target reference. Backlinks are derived by querying target_card_id; saving a link does not create a reverse row. Legacy JSON relation columns are read-only compatibility fallbacks.