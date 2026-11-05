# Movies Theory-Mode Validation Preregistration (2026-10-21)

## Status and reason

This plan is recorded before the mode-specific run. The prior fresh sample followed the previous plan but used the first mode (`impl`), which explicitly targets code and implementation searches. That sample is consumed and excluded. Since `theory` is documented for papers/books and long-form materials, this run checks a domain-appropriate application mode without changing the search algorithm.

## Data and selection

- Dataset: downloaded Reddit-TOMT Movies corpus, validation split only.
- Exclude all groups in `movies-validation-confirmatory-sample.json` and `movies-unused-validation-2026-10-21.json`.
- Select 200 complete target groups from the remaining validation groups by SHA-256 order using seed `my-search-movies-theory-validation-2026-10-21-v1`.
- Persist manifest and hash before ranking; no holdout access.

## Comparison and outcomes

- Production search uses the real `POST /api/search/terms` then `POST /api/cards/search` path on the isolated full corpus, explicitly selecting mode id `theory`.
- Comparator is independent standard BM25 over the same stored morphology tokens and complete corpus (k1=1.2, b=0.75), sharing only the frozen query parser and no product-specific scoring corrections.
- Primary descriptive comparison: per-query Hit@10 and paired group-level difference; report 95% group bootstrap CI, one-sided paired sign-flip p-value in the registered direction `theory-mode production > standard BM25`, and post-hoc approximate power. API failures/timeouts count as misses.
- Secondary descriptive outcomes: Hit@1, MRR@10, standard BM25 rank through 100/1000, and API p50/p95 latency. The normal API response exposes only the app's default result count; do not claim production Top100/Top1000 unless directly observed.
- No parameter changes or further mode selection based on this sample. This is still one benchmark domain and does not estimate natural saved-article refinding.
