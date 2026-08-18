# ADR-026: Remove unused hybrid card search implementation

## Context
`search/hybrid_card_search.ts` exports `runHybridCardSearch`, a complete
implementation that blends the BM25 engine with SQLite FTS5 (`cards_fts`)
for card ranking. It has no callers anywhere in the codebase (routes,
services, scripts, or tests). It was added in a single commit
("Complete search workflow and verification gates", 2026-07-31) and has
not been touched since.

The same BM25+FTS5 blending idea is already live through two other paths:
`search_engine.ts`'s `HybridSearchEngine` (selected via `SEARCH_ENGINE=hybrid`,
wired in `services/route_context.ts`) and `cards_repository.ts`'s
`CARD_SEARCH_ENGINE=fts5` path, both config-gated and covered by tests.
`hybrid_card_search.ts` duplicates functionality those two already provide.

## Decision
Delete `search/hybrid_card_search.ts`. Keep the hybrid ranking capability
in `HybridSearchEngine` and the `CARD_SEARCH_ENGINE=fts5` path, which are
the live, tested, config-gated implementations.

## Alternatives
- Keep it as reference code: rejected. It has no test coverage, is not
  imported, and would silently drift out of sync with `bm25_engine.ts`
  and the `cards_fts` schema as both evolve.
- Wire it in as a third search option: rejected. It does not cover a use
  case not already served by `HybridSearchEngine` or
  `CARD_SEARCH_ENGINE=fts5`.

## Consequences
No behavior change; nothing currently calls this code. Removes a
duplicate implementation of BM25+FTS5 blending so there is one hybrid
path for articles (`HybridSearchEngine`) and one for the card list filter
(`CARD_SEARCH_ENGINE=fts5`), instead of a third, unreachable variant.

## Evidence in code
`search/hybrid_card_search.ts` (to be deleted), `search/search_engine.ts`
(`HybridSearchEngine`), `repositories/cards_repository.ts`
(`CARD_SEARCH_ENGINE` check), `services/route_context.ts`
(`createSearchEngine()` call site).

## Reversal condition
Reconsider only if a use case emerges that neither `HybridSearchEngine`
nor `CARD_SEARCH_ENGINE=fts5` can serve.

## Status

Implemented: search/hybrid_card_search.ts was deleted after confirming there were no callers; the two supported hybrid search paths remain.
