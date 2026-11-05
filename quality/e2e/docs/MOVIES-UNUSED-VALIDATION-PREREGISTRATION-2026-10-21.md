# Movies Unused Validation Preregistration (2026-10-21)

## Status

This plan is fixed before running any search on the selected groups. It does not modify the queries, qrels, corpus, thresholds, or product ranking.

## Data and exclusion

- Dataset: the already downloaded Reddit-TOMT Movies corpus in `quality/e2e/data/reddit_tomt/movies`.
- Split: `validation` only. Do not read or use the Movies holdout.
- Exclude every group in `quality/e2e/artifacts/movies-validation-confirmatory-sample.json` (the previously consumed 200-group/297-query sample).
- Select 200 complete query groups from the remaining validation groups using SHA-256 order over the fixed seed `my-search-movies-unused-validation-2026-10-21-v1|<group_id>`.
- Save the resulting group/query manifest before executing either ranker. It is an untouched group sample from the pre-existing validation split, not a new data source and not a substitute for real saved-article use.

## Comparison

- Primary outcome: per-query Hit@10 difference, current production search API minus independent standard BM25.
- Production result: isolated SQLite DB populated with the complete Movies corpus, then the same `/api/search/terms` and `/api/cards/search` path used by the app; query/API errors count as misses and are reported.
- Standard BM25: independent offline implementation over the same complete corpus, query terms from the frozen current parser, and morphology token cache; k1=1.2, b=0.75, no custom context, coverage, extra rarity, time decay, or hybrid signal.
- Other descriptive outcomes: Hit@1, MRR, Recall/Hit@100 and @1000 where observable, and API latency p50/p95. No tuning after inspecting these groups.
- Query groups (shared gold target) are the inferential units. Aggregate query outcomes within each group and compare paired group differences. Report a two-sided 95% cluster-bootstrap interval and a one-sided paired sign-flip permutation p-value for the predeclared direction `production > standard BM25`.
- Report estimated power from the observed group-level variance only as a post-hoc approximation; do not present it as a prospective guarantee.

## Interpretation boundaries

This is one validation sample from one benchmark domain. The sample is not fully source-independent from prior TOMT development, validation, and consumed holdout work. It can provide a fresh untouched-group comparison if the exclusion manifest is honored, but it cannot certify the 95% real-user saved-article success target. No human-use records may be generated for this test.

## Post-run mode mismatch follow-up

The run above faithfully used the first configured mode, `impl`, but its description targets code/document searches, not recalled Books/Movies. This is a benchmark applicability confound. The run must not be interpreted as general search capability. A second, separately fixed sample and plan are therefore required before testing the domain-matching `theory` mode; the groups used above and in the earlier confirmatory manifest must be excluded. Do not tune the ranker against either validation sample.

