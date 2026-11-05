# JaCWIR 全コーパス検索: 候補深度200、未使用query 4201–4700

登録: 2026-10-24 JST  
状態: 対象・候補深度・方式・主指標・判定条件を結果確認前に固定。

## 仮説

BM25 Top-100で候補外となった既知正解を含めるため候補深度を200に広げれば、Top-100より候補再現率@100（候補集合深度200の意味ではRecall@200）とHit@10/nDCG@10が改善する可能性がある。一方、embedding構築量と検索レイテンシが増える。既存評価で候補深度100のRRFが実用目標の候補再現率0.98に未達だったことから、深度200を1段階だけ確認する。

## 固定条件

- source: local official `hotchpotch/JaCWIR` collection/eval Parquet; read-only.
- query: distinct query strings ordered by SHA-256(query), rows 4201–4700 (500 queries), all known positive qrels retained. This follows the previously used 3701–4200 block; exact overlap with existing local query blocks checked as 0 before ranking. Query SHA-256 `e631c4c78bf0ceb2e4b3e03f96ef7c17e5adaf0e4ee8296543ee45c315c46d12`, qrels SHA-256 `d17ca37617b4bb37f6ef702dcb362a09c7d79f726bde9c20cfed77c3fba5af8d`, manifest SHA-256 `95b65d5484921e792829631b5973fbca58e7404c92de51ae277071fc5ef18a81`, sorted qid-set SHA-256 `361f219f4473930b382a4c7029011dda1a08e5b6529b9d782b5fcb5607fb2e9f`; 500 queries and 502 known positives.
- corpus: all 513,107 documents, existing isolated morphological SQLite index, read-only.
- baseline: standard full-corpus morphological BM25, `k1=1.2`, `b=0.75`.
- candidates: BM25 Top-200. Compare BM25 ordering, E5 q8 reranking, and equal RRF `k=60` using exactly the same candidate set.
- fixed settings: tokenizer, query parser, model, qrels, candidate depth, RRF formula and evaluation metrics are not tuned after inspecting the result.
- primary metric: paired RRF−BM25 nDCG@10, shared-known-positive query clusters, 20,000 bootstrap draws, two-sided 95% percentile CI. Confirmatory improvement requires point estimate >0 and CI lower bound >0.
- practical targets: Hit@10 >=0.95; Hit@1 >=0.80; nDCG@10 >=0.85; candidate recall >=0.98 (report as Recall@200 for this run); retrieval p95 <=500ms. Report target attainment separately from statistical improvement.

## Limits and safety

JaCWIR questions are article-derived and qrels are known-positive, non-exhaustive. This is same-source benchmark work, not saved-card or user-session evidence. Do not alter production search, user data, labels, or target thresholds. Do not commit or push.

## Result (run completed 2026-10-25 JST)

- Standard BM25: Hit@1 `0.700`, Hit@10 `0.846`, nDCG@10 `0.776829`, MRR@10 `0.754156`, MAP@100 `0.756785`, Recall@100 `0.911`.
- E5 rerank within Top-200: Hit@1 `0.754`, Hit@10 `0.902`, nDCG@10 `0.833354`, MRR@10 `0.810990`, MAP@100 `0.812109`, Recall@100 `0.929`.
- Equal RRF within Top-200: Hit@1 `0.762`, Hit@10 `0.890`, nDCG@10 `0.825864`, MRR@10 `0.805837`, MAP@100 `0.807585`, Recall@100 `0.929`.
- Primary RRF−BM25 nDCG@10 difference `+0.049035`, 500 query clusters, paired bootstrap 20,000 draws, two-sided 95% CI `[+0.033661,+0.064666]`; Hit@10 difference `+0.044`, CI `[+0.026,+0.062]`. Preregistered improvement criterion met.
- E5 rerank nDCG@10 difference `+0.056525`, CI `[+0.030156,+0.082882]`; this remains a secondary result and does not replace the preregistered RRF primary analysis.
- Top-200 contains at least one known positive for `467/500=0.934` queries. This is below the provisional 0.98 threshold, even though the measured depth is 200 rather than 100.
- All 33 queries without a positive in Top-200 had their qrel document present in the 513,107-document index; the issue is retrieval rank/candidate inclusion, not a missing positive document. In sampled misses, some query and target titles share explicit topical wording (e.g. the `高い城の男` query/title and the `SQLインジェクション` query/title). This is a diagnostic clue only; the actual parser/posting overlap was not separately recomputed for this run, so no specific parser defect is claimed.
- p50/p95: BM25 `20.86/118.78 ms`, E5 `29.59/129.03 ms`, RRF `29.74/129.18 ms`. The p95 target is met.
- 85,835 unique candidates; first-time embedding build `1,598,347 ms` (~26m38s), model `118,308,185 bytes`, candidate vectors `131,842,560 bytes`, full BM25 index `977,752,064 bytes`, ending RSS/heap `1,769,013,248/723,780,144 bytes`.
- Output: `quality/e2e/artifacts/jacwir-full-retrieval-e5-rerank-500q-4201-4700-depth200-20261024-preregistered.json`.

The Top-200 run does not establish that deeper candidates improve over the Top-100 run because those runs use different fixed query blocks. Within this block, RRF improves over BM25, but Hit@10, Hit@1, nDCG, and candidate recall remain below the provisional practical targets. The known-positive labels are not exhaustive.
