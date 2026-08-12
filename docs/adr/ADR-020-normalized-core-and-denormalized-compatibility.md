# ADR-020: Combine normalized relations with denormalized compatibility fields

## Context

my-search evolved from JSON-backed card records to SQLite relations. The normalized `card_tags` and `card_links` tables provide queryability, foreign-key cleanup, backlinks, and integrity checks. Existing API consumers and older data paths still expect `tags` and `links` arrays, while cards also retain JSON and token fields used by compatibility and search paths.

## Decision

Use both forms deliberately, with different ownership:

- Normalized relation tables are canonical for tag and link reads, writes, filtering, deletion cleanup, and integrity checks.
- Denormalized JSON fields and API arrays remain compatibility representations for existing clients and migration paths.
- Precomputed tokens and full-text search data are derived search representations, not additional sources of truth.
- Writes update the normalized representation first and keep compatibility data synchronized where the current repository contract requires it.

The coexistence is intentional. It protects internal database correctness and searchability without forcing a breaking API change on existing consumers.

## Alternatives

- Keep only JSON arrays: rejected because relation filtering, backlinks, deletion cleanup, and integrity checks become weaker and more expensive.
- Remove all compatibility fields immediately: rejected because it would break existing API consumers and make migration unnecessarily disruptive.
- Treat both representations as independent authorities: rejected because divergence would make the returned card and database relations ambiguous.

## Consequences

- The database has explicit relational constraints and efficient relation queries.
- Existing clients can continue receiving the same array-shaped API fields.
- Synchronization and migration tests are required because two representations coexist.
- Compatibility fields must not be treated as evidence that the normalized relation tables are absent or non-canonical.
- Removing the compatibility layer remains a future breaking-change decision, not an incidental cleanup.

## Evidence in code

- `repositories/cards_repository.ts`
- `repositories/card_tags_repository.ts`
- `repositories/card_links_repository.ts`
- `db/migrate.ts`
- `docs/project-details.md`

## Reversal condition

Revisit this decision when all supported API consumers have migrated to relation-aware responses and a versioned API can remove the compatibility fields without breaking the published contract.
