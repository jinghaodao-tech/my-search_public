# QueryAnalysis重み付きBM25: 未使用クエリ分割での確認結果

計画: [元計画](BM25-PARSER-WEIGHTS-HOLDOUT-PLAN-2026-10-23-ja.md)、[評価分割変更の記録](BM25-PARSER-WEIGHTS-QUERY-SPLIT-AMENDMENT-2026-10-23-ja.md)。本確認は別の未使用query IDsを使ったが、同じFiQA/SciFact文書コーパスは過去の別方式評価でも使用済み。**独立コーパスの再現とは呼ばない。**

## 結論

Books developmentで小さな改善を見せた既存QueryAnalysis重みは、fresh-query-split確認では一貫した優位を示さなかった。FiQA devでHit@10は+0.20ポイントだが95%区間下限は0で、MRR/nDCGはわずかに負。SciFact trainではHit@10・Recall@100は同率、MRR/nDCG/MAPはわずかに負だった。**候補は不採用、本番BM25は変更しない。**

## 結果

各splitはtestとは別のqrel query IDsであり、test query IDとの重複は両方0。FiQA dev 500 query / 500 positive-qrel clusters、SciFact train 809 query / 490 clusters。差はparser-weighted − standard。

| Split | Method | nDCG@10 | MRR@10 | Hit@10 | Recall@100 | MAP@100 |
|---|---|---:|---:|---:|---:|---:|
| FiQA dev | Standard | 0.23435 | 0.29458 | 0.4460 | 0.50669 | 0.19731 |
| FiQA dev | Parser-weighted | 0.23424 | 0.29445 | 0.4480 | 0.50669 | 0.19730 |
| SciFact train | Standard | 0.66998 | 0.63431 | 0.81829 | 0.90900 | 0.62870 |
| SciFact train | Parser-weighted | 0.66927 | 0.63338 | 0.81829 | 0.90900 | 0.62778 |

| Split | Metric | Difference | paired cluster bootstrap 95% CI | Clusters |
|---|---|---:|---:|---:|
| FiQA dev | nDCG@10 | -0.000116 | [-0.000730,+0.000382] | 500 |
| FiQA dev | MRR@10 | -0.000133 | [-0.001000,+0.000600] | 500 |
| FiQA dev | Hit@10 | +0.0020 | [0.0000,+0.0060] | 500 |
| SciFact train | nDCG@10 | -0.000710 | [-0.001877,0.000000] | 490 |
| SciFact train | MRR@10 | -0.000927 | [-0.002451,0.000000] | 490 |
| SciFact train | Hit@10 | 0.0000 | [0.0000,0.0000] | 490 |

全正例qrelsがコーパス内に存在。自己qrelと正例無しでの除外クエリは0。

## コストと再現

| Split | Index build | 索引容量 | query p50 / p95 | RSS / max heap |
|---|---:|---:|---:|---:|
| FiQA dev | 7,498 s | 98.1 MB | 75 / 251 ms | 905 / 711 MB |
| SciFact train | 277 s | 14.9 MB | 12 / 33 ms | 571 / 254 MB |

- 評価器: `scripts/bench/benchmark_beir_query_weighted_bm25.ts`
- FiQA成果物: `quality/e2e/artifacts/beir-fiqa-dev-parser-weighted-20261023.json`
- SciFact成果物: `quality/e2e/artifacts/beir-scifact-train-parser-weighted-20261023.json`
- 両splitのコーパス/queries/qrels SHA-256、評価器指紋、全クエリ結果はJSONに記録。
- `npm.cmd run typecheck`: 成功。
- 既存DB、ユーザーカード、メモ、Reader、本番ランキングは変更していない。commit/pushなし。
