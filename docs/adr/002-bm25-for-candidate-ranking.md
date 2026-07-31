# ADR-002: BM25 for candidate ranking

## Context
Candidates need explainable lexical ranking before they are promoted to durable knowledge.
## Decision
Use BM25 with match metadata, synonyms, context bonus, and time decay for collection ranking.
## Alternatives
Substring-only filtering, vector search, or AI-only ranking.
## Consequences
Ranking is inspectable, local, and reproducible; semantic recall is a future comparison.
## Evidence in code
`bm25_engine.ts`, `routes/search_routes.ts`.
## Reversal condition
Reconsider after a measured quality dataset shows a better local baseline.
