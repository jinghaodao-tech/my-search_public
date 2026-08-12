# ADR-017: Defer heap-based top-K selection

## Context

The ranking pipeline currently sorts the scored result set and then applies the result limit. A heap-based top-K selector could reduce work when K is much smaller than the corpus, but it would require changing the pipeline order and adding another selection implementation.

The current corpus is approximately 216 articles, so K is not yet small enough for the expected speed difference to justify that complexity. This is separate from LSH deduplication: LSH trades candidate-recall risk for reduced duplicate-comparison work, while heap selection can preserve the exact top-K result.

## Decision

Keep the current exact sort-and-limit path. Treat heap usage as a monitored bottleneck and defer the optimization until corpus growth or measured profiling shows a meaningful benefit, expected around the tens-of-thousands scale.

## Consequences

- Current ranking order remains easy to inspect and compare with the baseline.
- No ranking accuracy or reproducibility is sacrificed.
- The partial-selection path for large `n` and small `K` is not optimized yet.
- A future change must compare exact top-K output and measured latency before adoption.

## Reversal

Revisit this decision when a production-like benchmark demonstrates that sorting dominates the pipeline and a heap selector can reproduce the exact top-K result.

## Related Decisions

- [ADR-016: LSH-based article deduplication](ADR-016-lsh-deduplication.md)
