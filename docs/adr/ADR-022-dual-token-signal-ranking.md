# ADR-022: Store dual token signals and blend normalized BM25 scores

## Context

Japanese search benefits from morphological tokens for semantic precision and character N-grams for unknown compounds and spelling variation. Recomputing either representation when switching search behavior would add avoidable work. A single expanded `tokens_json` field also hid which signal produced a ranking result.

## Decision

Store both morphological tokens and N-gram tokens at write or backfill time, with a document length for each representation. Keep the existing `tokens_json` and `doc_length` fields as the backward-compatible N-gram view.

For each search, compute BM25 independently for the two token sets. Normalize each signal against the active corpus maximum, then combine them with mode-specific weights. Implementation mode favors morphological precision; theory and trend modes give N-grams more weight for unknown terms. Ranking details expose both raw scores, normalized scores, weights, and the combined score.

## Alternatives

- Re-tokenize when a mode changes: rejected because it repeats write-time work during search.
- Store only expanded N-grams: rejected because it hides semantic-token behavior and prevents independent weighting.
- Add raw BM25 scores directly: rejected because the two token spaces have different lengths and score ranges.

## Consequences

- Search can compare tokenization strategies without changing the stored corpus.
- Index writes and backfills store more JSON, and migrations must populate compatibility values for existing rows.
- Corpus-relative normalization means scores are comparable within a search run, not across unrelated corpora.
- Evaluation must compare the token modes on the versioned 50-case real dataset before changing production weights.

## Reversal condition

Revisit the dual-signal path if measured storage or write-time cost outweighs a reproducible quality improvement, or if a single tokenizer becomes demonstrably sufficient across the versioned evaluation set.
