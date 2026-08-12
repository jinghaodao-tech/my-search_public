# ADR-019: Card list filter (`q=`) uses LIKE, not an index

## Context

`GET /api/cards?q=` filters with `title LIKE '%...%'`. Verified with `EXPLAIN QUERY PLAN`, this reports `SCAN cards`; it does not use `idx_cards_title`. A B-tree index can jump to values sharing a given prefix, but has no way to jump to "contains this substring anywhere," so a leading wildcard defeats the index regardless of row count.

## Decision

Keep the LIKE-based substring filter as-is. A controlled benchmark on the current dataset (233 rows, warmed and measured under identical conditions on two copies of the same file) recorded the indexed exact-match path at approximately 7.1 microseconds per query versus approximately 43.5 microseconds for the equivalent full scan — about 6x. That speedup is specific to prefix/exact match and cannot apply to arbitrary substring search at any row count. This is a documented scope decision, not an oversight: `cards_fts` (see ADR-018) already exists as an FTS5-backed full-text alternative and is the natural upgrade path if substring-search latency is ever measured as a problem.

## Consequences

- `q=` filtering cost scales with the number of rows scanned, not with an index lookup.
- No behavior change; this records an existing, previously undocumented architecture boundary.
- If substring-search latency is ever measured as a bottleneck, the fix is routing through `cards_fts`, not attempting to index a leading-wildcard LIKE.

Related: [ADR-018: Record the absence of an inverted index](ADR-018-no-inverted-index.md).

## Reversal

Revisit if production-like profiling at a larger corpus size shows `q=` scanning as a measured bottleneck.
