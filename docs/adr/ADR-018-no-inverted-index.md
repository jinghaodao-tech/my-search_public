# ADR-018: Record the absence of an inverted index

## Context

The search implementation stores normalized or precomputed tokens with articles, but it does not maintain an inverted index that maps each token to the documents containing it. A token cache and corpus statistics are not an inverted index.

## Decision

Record the current architecture explicitly: BM25 scoring still scans the available article token data for each search pipeline run. No inverted-index lookup or postings-list maintenance is currently part of the search contract.

This is a documented implementation boundary, not a claim that an inverted index is unnecessary. Its introduction remains a separate decision that must be supported by measured workload data and an exact-result regression test.

The current corpus is approximately 216 articles, and article scanning has not been shown to be the dominant measured cost. BM25 scoring does not require an inverted index, while adding one would introduce posting-list maintenance, mutation consistency, memory usage, and index-build costs. We therefore defer adoption until production-like profiling demonstrates a meaningful benefit.

## Consequences

- Search work remains dependent on the number of articles and their token data.
- Index freshness and mutation consistency are simpler because there is no postings-list update path.
- LSH deduplication does not provide inverted-index behavior; it only narrows duplicate comparisons before ranking.
- A future inverted index must preserve ranking results, update correctly on article changes, and report memory/build costs separately.

## Reversal

Revisit this boundary when production-like profiling shows article scanning is the dominant search cost at the target corpus size.
