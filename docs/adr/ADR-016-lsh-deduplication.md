# ADR-016: LSH-based article deduplication

## Context

Article deduplication previously compared every pair of article shingle sets. That made the production path O(n^2), even though the exact Jaccard check is only needed for likely near-duplicates.

## Decision

Replace the all-pairs candidate search with a deterministic MinHash LSH index. The implementation uses 64 signature permutations arranged as 16 bands of 4 rows. LSH generates candidate pairs, and exact Jaccard similarity remains the final duplicate decision at the configured threshold.

The regression contract is duplicate-pair recall of at least 85% against the exact all-pairs baseline. The exact baseline is retained for evaluation only and is not used by the production pipeline.

## Consequences

- Feature and index construction is approximately O(n), excluding feature extraction.
- Full deduplication is approximately O(nc), where c is the average LSH candidate count.
- Hash collisions create extra exact comparisons but cannot by themselves mark an article as a duplicate.
- The recall target is measured by a deterministic regression test, not assumed from the LSH parameters.

Related: [ADR-017: Defer heap-based top-K selection](ADR-017-defer-heap-top-k-selection.md).

## Reversal

If real-corpus duplicate-pair recall falls below 85%, increase the signature/banding budget or temporarily restore an exact fallback for the affected corpus size. Do not silently lower the threshold.
