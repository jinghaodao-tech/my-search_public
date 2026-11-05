# 標準BM25 + 形態素FTS5 RRF 独立評価結果

計画: [独立評価計画](BM25-MORPH-FTS-RRF-HOLDOUT-PLAN-2026-10-23-ja.md)。データ配布元と公式サイズ・MD5は[BEIR公式リポジトリ](https://github.com/beir-cellar/beir)を参照。

## 結論

事前固定した`standard BM25 + morphology FTS5 RRF(k=60)`は、**2データセットで安定した優位を示さなかったため不採用**。SciDocsのHit@10は+0.50ポイントだが、95%区間下限は0。QuoraではHit@10がわずかに低下し、MRR@10とMAP@100も区間が負側だった。本番ランキングは変更しない。

## 品質

全値はクエリ単位のマクロ平均。qrelsで正解文書を共有するクエリ群をクラスタ化した対応bootstrap 95%区間。

| Dataset | Queries / docs | Method | Hit@10 | Hit@1 | Recall@100 | MRR@10 | nDCG@10 | MAP@100 |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| SciDocs | 1,000 / 25,657 | Standard BM25 | 0.4840 | 0.1880 | 0.35085 | 0.27401 | 0.15331 | 0.10404 |
| SciDocs | 1,000 / 25,657 | BM25 + morph FTS RRF | 0.4890 | 0.1900 | 0.35170 | 0.27559 | 0.15433 | 0.10464 |
| Quora | 10,000 / 522,931 | Standard BM25 | 0.8575 | 0.6005 | 0.93565 | 0.68628 | 0.69701 | 0.65381 |
| Quora | 10,000 / 522,931 | BM25 + morph FTS RRF | 0.8574 | 0.6003 | 0.93550 | 0.68613 | 0.69688 | 0.65367 |

| Dataset | Metric | Candidate − standard | 95% cluster bootstrap CI | Clusters |
|---|---|---:|---:|---:|
| SciDocs | Hit@10 | +0.0050 (+0.50 pp) | [0.0000, +0.0072] | 350 |
| Quora | Hit@10 | -0.0001 (-0.01 pp) | [-0.0003, 0.0000] | 10,000 |

SciDocsではnDCG@10差が+0.00102 [0.00007, 0.00172]、MAP@100差が+0.00060 [0.00018, 0.00095]。QuoraではMRR@10差が-0.000154 [-0.000322, -0.000024]、MAP@100差が-0.000141 [-0.000287, -0.000028]だった。QuoraのnDCG@10差は-0.000123 [-0.000266, +0.000004]。効果は小さく、両領域で方向が揃わない。

正例qrelはSciDocs 4,928件、Quora 15,675件。両データセットでコーパスに存在しない正解文書は0件。Quoraではquery IDと同じdocument IDの自己qrel 0件、正解なしで評価から除外したクエリ0件。

## コスト

| Dataset | Index build | SQLite index | query p50 / p95 | process RSS | max heap |
|---|---:|---:|---:|---:|---:|
| SciDocs | 1,083 s | 262,565,888 bytes | 104 / 282 ms | 707 MB | 428 MB |
| Quora | 449 s | 224,714,752 bytes | 114 / 542 ms | 1,091 MB | 1,031 MB |

検索レイテンシはBM25とFTS5の両方を評価した処理時間。RSS/heapは当該ベンチマークプロセス全体で、製品の増分メモリではない。

## 再現と保全

- 評価器: `scripts/bench/benchmark_beir_bm25_fts_rrf.ts`。Kuromoji文書・クエリトークンを同一にし、FTS5へは形態素ごとに可逆hex符号化して格納。隔離SQLiteへストリーム構築し、`--resume`では既存索引がコーパスprefixに一致することを先に照合。
- SciDocs成果物: `quality/e2e/artifacts/beir-scidocs-standard-morph-rrf-20261023.json`。
- Quora成果物: `quality/e2e/artifacts/beir-quora-standard-morph-rrf-20261023.json`。
- 配布ZIPの公式MD5: SciDocs `38121350fc3a4d2f48850f6aff52e4a9`、Quora `18fb154900ba42a600f84b839c173167`。評価入力のSHA-256と評価器指紋はJSON成果物に保存。
- `npm.cmd run typecheck`: 成功。
- 評価完了後、この2テストを調整・ホールドアウト再利用しない。本番ランキング、ユーザDB、カード、メモ、Readerは変更していない。commit/pushなし。
