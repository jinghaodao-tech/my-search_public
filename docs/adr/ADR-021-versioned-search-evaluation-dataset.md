# ADR-021: Use a versioned, stratified search evaluation dataset

## Context

Search quality decisions were previously sensitive to a small number of hand-written cases. A single correct or incorrect result could move the aggregate materially, and the dataset did not expose whether a case was easy, ambiguous, specialized, or had multiple relevant documents. This is especially risky when comparing tokenizer or ranking changes.

## Decision

Keep the 57-document synthetic dataset as a stable ranking diagnostic and end-to-end gate, and maintain a separate real-corpus release signal with at least 50 manually authored queries. The real dataset is versioned as `anonymized-card-corpus-v2-50-manual-queries` and is stored across `real-queries.json` and `real-queries-v2.json` so the original 20-case baseline remains reviewable.

Each new real case records its kind, difficulty, language, and whether it has one or multiple relevant documents. Queries must be unique, expected document IDs must be explicit, and automatic token probes remain diagnostics rather than relevance labels.

## Alternatives

- Keep 11 or 20 cases: rejected because aggregate metrics are too sensitive to one case.
- Generate all queries from document tokens: rejected because it creates circular, unrealistically easy labels.
- Replace the synthetic dataset: rejected because the synthetic corpus isolates ranking and parser regressions useful for diagnosis.

## Consequences

- Tokenizer and ranking changes are evaluated against a less volatile real-corpus signal.
- Difficulty and relevance cardinality can be reported by stratum instead of hidden inside one aggregate.
- Manual labeling remains work and must be refreshed as the corpus and search behavior change.
- A score on this dataset is still not a universal production accuracy claim; it is a versioned regression signal.

## Reversal condition

Revisit the dataset design when an independently collected query log or a larger reviewed relevance set is available, preserving the current version as a historical comparison point.
