# ADR-015: Real-corpus search evaluation and bigram cost

## Decision

Keep the curated synthetic evaluation as a stable diagnostic and release gate, and add a separate `real` scope backed by a local-card-derived anonymized fixture. The real scope uses manually authored queries from `data/search-evaluation/real-queries.json` and is a release signal with a modest P@1 threshold of 0.70.

The fixture preserves search difficulty by retaining token arrays, document length, relative update age, vocabulary, and Japanese terms. It removes raw identifiers, text, URLs, and source dates. `npm run check:search-fixture` verifies both privacy shape and a minimum vocabulary/document-length profile.

Japanese bigrams remain enabled because they address unknown compounds and Japanese recall. The cost is measured from the real database by comparing morphological-only tokens with expanded tokens in `artifacts/tokenization-cost.json`; the same artifact also records token JSON payload bytes and fresh-tokenization latency. Stored `tokens_json` remains the runtime path so this indexing cost is paid on write/backfill rather than every search.

## Evidence

Run:

```bash
npm run build:search-fixture
npm run check:search-fixture
npm run benchmark:tokenization
npm run evaluate:search
```

The evaluation artifact reports `ranking-only`, `end-to-end-query`, and `real` side by side. The decay sweep separately records P@1 by floor and fails if the production floor loses its passing window.

## Consequences

The real scope is more representative than the synthetic fixture. The release artifact uses the versioned anonymized corpus at `data/search-evaluation/anonymized-corpus.json` plus a manually authored query file with ambiguous queries and multiple relevant documents; its P@1 gate is intentionally lower because the corpus is small and noisy. The evaluator rejects all-upper-bound, conflicting duplicate, degenerate-language, and near-zero-recall profiles as non-discriminating. Bigram expansion increases token/index payload and write-time tokenization, so the trade-off is visible in the artifact instead of being presented as a free accuracy improvement.
