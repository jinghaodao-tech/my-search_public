# ADR-025: Japanese tokenization strategy

## Context

Japanese queries do not consistently provide whitespace boundaries. Morphological tokenization provides meaningful terms but depends on a dictionary and can miss new compounds or unusual notation. Character bigrams improve recall for unknown compounds and spelling variation, at the cost of larger token payloads and more scoring work.

## Decision

Use morphological tokens and Japanese character bigrams together. Compute both at write or backfill time, persist both token arrays and both document lengths, and blend their independently normalized BM25 signals by search mode. Morphological tokens receive more weight in implementation-oriented search; N-grams receive more weight in theory and trend modes where unknown terms are more likely.

Evaluate changes against the versioned real dataset, including Japanese cases, ambiguous queries, multiple relevant documents, and tokenization-cost measurements. Do not claim that bigrams alone provide a universal Japanese-language solution.

## Alternatives

- Morphological tokens only: rejected because unknown compounds and new terms reduce recall.
- Character bigrams only: rejected because semantic precision and interpretable token matches become weaker.
- Re-tokenize at query time: rejected because it adds avoidable latency and makes mode comparisons less reproducible.
- External morphological service: deferred because it conflicts with the local-first boundary and adds operational dependencies.

## Evidence

- ADR-006 established write-time token persistence.
- ADR-015 records Japanese bigram quality and cost measurements.
- ADR-022 records dual-token storage and mode-specific BM25 blending.
- `npm run evaluate:search` and `npm run benchmark:tokenization` are the required comparison commands.

## Consequences

Japanese recall improves for unknown or compound terms, while index storage and write/backfill work increase. The two signals can be inspected separately in ranking details, but scores remain corpus-relative and must be compared on a fixed evaluation dataset.

## Reversal condition

Revisit the strategy if a sufficiently representative evaluation set shows that one tokenizer is consistently as good or better at materially lower storage and processing cost.
