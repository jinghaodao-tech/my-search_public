# Search Quality Evaluation

The repository includes a deterministic search-quality evaluation in addition to latency benchmarks.

The artifact keeps three scopes separate: `ranking-only` is a synthetic ranking diagnostic, `end-to-end-query` is the curated synthetic release gate, and `real` runs parser-based evaluation over the anonymized local-card corpus with manually authored relevance labels. `real` is now a release signal with a modest P@1 gate of 0.70; automatic probes remain fixture diagnostics only.

## Dataset

The evaluation uses 57 documents and 20 hand-labeled English/Japanese queries (dataset version v5-57-docs-20-query-cases), including 10 dedicated Japanese cases. It includes clear positives, near-negatives, title/body conflicts, time-decay traps, parser ambiguity, short and long text, unknown Japanese compounds, and mojibake detection samples.

## Metrics

- Precision@1
- R-Precision (top R results, where R is the number of expected documents)
- Mean Reciprocal Rank (MRR)
- Recall@5
- nDCG@5

The script also compares current BM25 against variants without synonym expansion and without time decay. Each variant is labeled with a stable `name` and `description` in the artifacts.

Ranking-only evaluates pre-parsed keyword candidates and isolates the ranking engine. It is a diagnostic scope for engine-level comparison and is not the release gate. End-to-end evaluates the raw query through phrase parsing, exclusions, synonym expansion, and Japanese tokenization, and is the primary release gate. A gap between these two reports is therefore treated as parser improvement headroom, not as a ranking-only regression.

Keyword weights combine the caller-provided term weight with an IDF-derived rarity multiplier, so terms appearing in fewer documents contribute more than common terms.

Japanese compound-word amplification is bounded at `3.0`, matching the maximum parser weight used for an English quoted phrase. This prevents token count from silently making a Japanese keyword stronger than an explicitly weighted English phrase; IDF rarity remains a separate corpus-level multiplier.

## Run

```bash
npm run evaluate:search
```

The current run reports the dataset size, per-case metrics, aggregate metrics, theoretical upper bounds, variant comparison, thresholds, score breakdowns, tokenization diagnostics, mojibake samples, and failure-case tables. The end-to-end gate requires Precision@1 >= 0.75, R-Precision >= 0.75, MRR >= 0.80, Recall@5 >= 0.80, and nDCG@5 >= 0.75. R-Precision is used instead of Precision@3 because the expected document count varies by case. Any measured metric above its dataset-specific theoretical upper bound fails verification.

`artifacts/search-quality.json` includes `rankingDetails` for every case with `documentId`, `rank`, `finalScore`, `bm25Score`, `contextBonus`, `timeDecayFactor`, `matchedTerms`, and `isExpected`. Each case also has a `sensitivity` summary: winner/runner-up score gap, BM25 and decay gaps, the runner-up BM25/decay needed to tie, and the winner decay needed to lose. It also includes `failureCases`, a near-negative success table, and `tokenizationDiagnostics` with implementation locations and executed token samples.

The evaluator also assesses dataset discrimination. If every aggregate metric reaches its theoretical upper bound, the artifact records `datasetQuality.status=invalid-all-metrics-at-theoretical-upper-bound` and a warning; a perfect score is treated as a dataset defect signal, not evidence of search quality.

## Limits

This is a deterministic regression fixture, not a general web-search benchmark. Relevance labels are intentionally small and curated for portfolio-level regression detection.

The real release signal currently has 20 manually authored queries over an
anonymized local corpus. It detects meaningful regressions at P@1 >= 0.70, but
it cannot establish production-wide relevance, coverage of every user intent,
or statistical confidence for individual query families. Growing the corpus
and labels is still required before tightening the gate.

The tokenizer uses kuromoji morphological tokens plus Japanese character bigrams as an unknown-word fallback. This improves recall but increases token and index size; the deterministic fixture keeps ranking metrics visible so that the trade-off remains reviewable.

`npm run build:search-fixture` reads the local SQLite cards table and writes an ignored anonymized corpus under `data/search-evaluation/`. It hashes IDs and omits raw title/body/URLs while preserving token arrays, document lengths, relative update age, and archive status. The current local database produced 233 documents and 18,138 tokens. Relevance scores are not automatically substituted for the hand-labeled fixture: doing so from a card's own title would be circular, so manually labeled query cases are still required for a trustworthy real-card score.

`npm run benchmark:tokenization` compares the real database's stored-token read cost with fresh kuromoji plus Japanese-bigram tokenization and writes `artifacts/tokenization-cost.json`. This is a current cost baseline; an old pre-bigram implementation is not reconstructed as a false historical comparison.

The fixture evaluates user-visible candidates with an archive score threshold of `2.0`, making low-confidence shared-token matches visible as below-threshold results instead of counting them as retrieved results.

The evaluation also sweeps `lambda` from `0.000` to `0.200` in `0.005` steps and floors from `0.25` to `0.50` for `jp-saved-search` and `time-decay`. `artifacts/search-quality.json` records plot-ready `pAt1ByLambda` points for every floor, plus the passing-window width. The evaluator requires the production floor `0.35` to retain a non-zero passing window, so a narrow decay window becomes a regression signal rather than an undocumented tuning detail. `jp-saved-search` intentionally accepts `jp-search`, `saved-new`, and `saved-old`, because the query does not contain a term that distinguishes those three records. `time-decay` accepts the two saved-record variants, so the sweep can evaluate freshness without treating a semantically relevant saved record as a false failure.

The measured passing configurations are selected by the full quality gate, then the median configuration is used as the default: `lambda = 0.065`, `timeDecayFloor = 0.40`. This is a dataset-backed operating point, not a universal decay constant; expanding the floor sweep changed the selected median from the earlier `0.085 / 0.35` operating point.

FTS5 is now a production-capable local index through `HybridSearchEngine`; vector search remains a comparison candidate only.
