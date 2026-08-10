# ADR-006: Precomputed search tokens

## Context
Morphological tokenization during every search caused avoidable latency.
## Decision
Persist `tokens_json` and `doc_length` when cards/articles are saved and backfill them through scripts.
## Alternatives
Tokenize on every query or adopt an external search index.
## Consequences
Warm BM25 searches are faster and benchmarkable; migrations must preserve cache compatibility.
## Evidence in code
`repositories/cards_repository.ts`, `scripts/backfill_card_tokens.ts`.
## Reversal condition
Reconsider if cache invalidation becomes more expensive than indexing.
