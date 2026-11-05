# Query-likelihood rankers: FiQA development and fixed TREC-COVID transfer

## Purpose and status

This is an exploratory comparison of two established probabilistic retrieval families against the repository's standard morphology-token BM25. It does not alter the production ranker. Both corpora, their indexes, and query sets have appeared in earlier ranking exploration; these runs are not fresh independent confirmation.

## Frozen comparison

- Shared query path: `purposeWords()` and `analyzeQuery()`, then unique morphology terms, same as the standard scorer in the RM3 index benchmark.
- Full indexed corpus; same qrels, document IDs, posting index, positive-grade definition, and Top-100 output for each method.
- Standard BM25 fixed at `k1=1.2`, `b=0.75`.
- Dirichlet query likelihood: `sum(log((tf + mu * collectionProbability) / (documentLength + mu)))`, with `mu` in `{250, 500, 1000, 2000, 4000}`.
- Jelinek-Mercer query likelihood: `sum(log((1-lambda) * tf/documentLength + lambda * collectionProbability))`, with `lambda` in `{0.05, 0.1, 0.2, 0.3, 0.5}`.
- OOV terms are omitted by all rankers, matching the existing BM25 scorer's behavior. For query-likelihood rankers, every corpus document is scored, including documents with no matching query term; this is not a candidate-truncated comparison.
- FiQA development parameters are treated only as exploratory. The full fixed grid is reported on the transfer set to show parameter sensitivity; no TREC-COVID result is used to retune.
- Paired percentile bootstrap resamples connected components of the positive query-document qrel graph. TREC-COVID has one connected component, so its interval is degenerate and is not inferential evidence.

## FiQA development: 500 queries, 57,638 documents

| Ranker | Hit@10 | nDCG@10 | MRR@10 | MAP@100 | Recall@100 | ranking p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| Standard BM25 | 0.426 | 0.22321 | 0.27978 | 0.18787 | 0.48925 | 2.12 / 6.72 ms |
| Dirichlet, mu=250 | 0.426 | 0.22635 | 0.27977 | 0.18946 | 0.48423 | 10.15 / 18.37 ms |
| Jelinek-Mercer, lambda=0.5 | 0.428 | 0.22620 | 0.27824 | 0.18942 | 0.48323 | 8.84 / 16.28 ms |

The highest nDCG point estimate is Dirichlet `mu=250`, delta `+0.00315`, paired cluster-bootstrap 95% CI `[-0.00681, +0.01312]`. Jelinek-Mercer `lambda=0.5` delta is `+0.00300`, CI `[-0.00545, +0.01185]`. Neither establishes improvement. Ranking-only p50 is about 4.8x and 4.2x standard BM25 respectively; query parsing and the shared posting fetch are excluded from each ranker's timing.

## Fixed transfer: TREC-COVID test, 50 queries, 171,332 documents

| Ranker | Hit@10 | nDCG@10 | MRR@10 | MAP@100 | Recall@100 | ranking p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| Standard BM25 | 0.940 | 0.42083 | 0.63852 | 0.04862 | 0.08499 | 8.59 / 20.52 ms |
| Dirichlet, mu=250 | 0.960 | 0.39104 | 0.63827 | 0.03938 | 0.07486 | 26.13 / 43.39 ms |
| Dirichlet, mu=500 | 0.980 | 0.39270 | 0.59110 | 0.04089 | 0.07618 | 27.37 / 48.93 ms |
| Jelinek-Mercer, lambda=0.5 | 0.960 | 0.39512 | 0.65033 | 0.03680 | 0.07020 | 22.50 / 37.85 ms |

All tested query-likelihood settings had lower nDCG@10 than BM25 (best observed delta `-0.02571`, Jelinek-Mercer lambda=0.5). Several settings increased binary Hit@10 while reducing nDCG, MAP, and Recall: relevant results were found somewhere in Top10 more often, but their graded ordering and broader retrieval were worse. Because all 50 test queries belong to one positive-qrel connected component, bootstrap intervals collapse to a point and cannot support a population-level claim. This is a fixed transfer diagnostic, not independent certification.

## FiQA-selected settings transferred to Quora development

The best FiQA nDCG point-estimate settings (`mu=250`, `lambda=0.5`) were applied without retuning to a preselected SHA-256-first 100-query sample from the 522,931-document Quora development corpus. This Quora sample and corpus have been used in prior experiments, so this is a fixed transfer diagnostic, not a new holdout.

| Ranker | Hit@10 | nDCG@10 | MRR@10 | MAP@100 | Recall@100 | ranking p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| Standard BM25 | 0.840 | 0.66815 | 0.69008 | 0.61992 | 0.94141 | 2.67 / 10.37 ms |
| Dirichlet, mu=250 | 0.820 | 0.62694 | 0.64641 | 0.57387 | 0.92416 | 68.48 / 113.78 ms |
| Jelinek-Mercer, lambda=0.5 | 0.840 | 0.67111 | 0.68761 | 0.61593 | 0.94236 | 59.70 / 98.86 ms |

Dirichlet nDCG delta was `-0.04121` (95% paired cluster-bootstrap CI `[-0.08312, -0.00294]`), with a substantial latency increase. Jelinek-Mercer nDCG delta was `+0.00296` (CI `[-0.01628, +0.02356]`), statistically uncertain and about 22x slower at p50. Neither setting demonstrates stable superiority; the Dirichlet candidate selected by FiQA's best point estimate materially regressed on Quora.

## Fixed Top-100 RRF combination

For each query, standard BM25 Top-100 and one FiQA-selected query-likelihood Top-100 list were fused with RRF `k=60`; no tuning was done on transfer results. RRF considers the complete Top-100 output from each component (union up to 200 documents). The pipeline latency below is the sum of separately measured component and fusion times, not a single end-to-end wall-clock run.

| Dataset | Fused ranker | nDCG@10 | Difference vs BM25 (95% paired cluster CI) | summed p50 / p95 |
|---|---|---:|---:|---:|
| FiQA dev, 500 | BM25 + Dirichlet mu=250 | 0.22383 | +0.00063 `[-0.00500, +0.00635]` | 13.29 / 23.22 ms |
| FiQA dev, 500 | BM25 + Jelinek-Mercer lambda=0.5 | 0.22284 | -0.00036 `[-0.00505, +0.00459]` | 11.59 / 20.96 ms |
| Quora dev hash-100 | BM25 + Dirichlet mu=250 | 0.67626 | +0.00811 `[-0.01653, +0.03296]` | 74.79 / 126.97 ms |
| Quora dev hash-100 | BM25 + Jelinek-Mercer lambda=0.5 | 0.67626 | +0.00811 `[-0.00183, +0.01961]` | 61.91 / 105.81 ms |
| TREC-COVID test, 50 | BM25 + Dirichlet mu=250 | 0.41180 | -0.00903 (one cluster; no inferential CI) | 34.21 / 72.45 ms |
| TREC-COVID test, 50 | BM25 + Jelinek-Mercer lambda=0.5 | 0.41299 | -0.00784 (one cluster; no inferential CI) | 31.96 / 58.21 ms |

RRF did not establish a repeatable gain: both fusions are statistically uncertain on FiQA and Quora, and both decrease nDCG on the TREC-COVID transfer diagnostic. Query-likelihood scoring remains a large latency cost on the 522,931-document Quora corpus. The apparent Quora improvement cannot override the lack of confirmation on the other corpora.

## Integrity, implementation, and resources

Both runs recorded SQLite `integrity_check=ok`, exact corpus/index document-ID parity, and exact morphology-token frequency parity for 25 deterministic hash-selected documents. Corpus, query, qrels, and index SHA-256 hashes are stored in the JSON outputs. The original DB was opened read-only.

The TREC-COVID process ended at RSS 1.25 GB / heap 212 MB; FiQA ended at RSS 729 MB / heap 181 MB. These are process-end totals, not per-ranker peaks or incremental memory. Query-likelihood scoring visits every document for every query; no candidate shortcut was used. No production data, application route, or default ranker was changed.

Files:

- `scripts/bench/language_model_rankers.ts`
- `scripts/bench/benchmark_beir_language_models.ts`
- `tests/language_model_rankers.test.ts`
- `quality/e2e/artifacts/fiqa-dev-language-model-grid-20261024.json`
- `quality/e2e/artifacts/trec-covid-test-language-model-transfer-20261024.json`
- `quality/e2e/artifacts/quora-dev-language-model-grid-hash100-20261024.json`
- `quality/e2e/artifacts/fiqa-dev-language-model-fusion-grid-20261024.json`
- `quality/e2e/artifacts/trec-covid-test-language-model-fusion-grid-20261024.json`
- `quality/e2e/artifacts/quora-dev-language-model-fusion-grid-hash100-20261024.json`

Verification: `npx.cmd vitest run tests/language_model_rankers.test.ts --pool=threads --fileParallelism=false` (5 passed); `npm.cmd run typecheck` (passed); all six benchmark runs completed. The independent confirmation requirement remains unmet. Embedding retrieval remains untested because no local model or inference runtime is present; obtain explicit approval before downloading the quantized model and runtime.

## Decision

Do not adopt Dirichlet or Jelinek-Mercer as a replacement or fusion signal based on these results. The small, uncertain FiQA nDCG gains did not transfer; TREC-COVID showed a material nDCG loss and roughly 2.6-3.2x ranking latency. Standard BM25 remains the best-supported default among the tested lexical rankers, not a universally proven optimum. The next materially different candidate is a locally run multilingual embedding ranker, evaluated on fixed queries with model-inference latency and storage cost included.
