# 標準BM25とタイトル専用BM25のRRF評価

## 結論

タイトルだけで順位付けするBM25を標準BM25へRRF融合する方式は棄却する。SciFact trainで等重みRRFは大きく悪化した。別のMovies developmentで固定されたタイトル信号weight=0.1へ弱めても、Hit@10は同程度の一方、MRR・nDCG・MAPが統計的に低下した。追加候補として保持する根拠はない。本番ランキングは変更しない。

## 評価条件

- データ: SciFact train、5,183文書、809クエリ、qrel正解共有490クラスタ。全文書に非空タイトルあり。
- 標準BM25: Kuromoji形態素トークン、正値化IDF、k1=1.2、b=0.75。
- title-only BM25: タイトル列内のterm DF、タイトル平均長、タイトル文書長を使用し、k1=1.2、b=0.75。正解qrelsを使ったランキング調整なし。
- 比較候補: 標準BM25とtitle-only BM25のRRF k=60。title信号weight=1の等重みと、Movies開発データで用いられた固定weight=0.1を評価。SciFact上では重みを選択・調整していない。
- すべての方式で同じトークン化、クエリ解析、文書集合、qrelsを利用。クラスタbootstrap 95%区間を使用。
- SciFact trainは他の比較で既に探索利用済み。今回の数値は探索的転移診断であり、最終独立評価ではない。

## 結果

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | MAP@100 | Recall@100 | p50/p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 標準BM25 | 0.5550 | 0.8183 | 0.6343 | 0.6700 | 0.6287 | 0.9090 | 1.95 / 5.24 |
| 標準BM25 + title-only RRF (weight=1) | 0.4240 | 0.6761 | 0.5022 | 0.5323 | 0.4960 | 0.8931 | 2.71 / 8.04 |
| 標準BM25 + title-only RRF (weight=0.1) | 0.4907 | 0.8171 | 0.5949 | 0.6392 | 0.5879 | 0.9078 | 2.64 / 8.03 |

| 比較候補−標準 | 差 | クラスタbootstrap 95% CI | クラスタ数 |
|---|---:|---:|---:|
| 等重み Hit@10 | -0.14215 | [-0.17897, -0.10719] | 490 |
| 等重み nDCG@10 | -0.13768 | [-0.17285, -0.10395] | 490 |
| weight=0.1 Hit@10 | -0.00124 | [-0.01009, +0.00732] | 490 |
| weight=0.1 MRR@10 | -0.03937 | [-0.06147, -0.01939] | 490 |
| weight=0.1 nDCG@10 | -0.03081 | [-0.04748, -0.01535] | 490 |

weight=0.1はHit@10の大幅悪化を避けたが、上位の順位品質を維持できなかった。等重みとweight=0.1の両方でMAP@100も低下した。係数をSciFactに合わせて小さくし直すことはしていない。

## 速度・実装監査

- RRFは標準BM25の全順位とtitle-onlyの全順位を融合した。ランキングp50/p95は標準BM25 1.95/5.24ms、weight=0.1候補2.64/8.03ms。
- weight=0.1のp95は約1.53倍。品質改善がないため、追加信号・計算コストを正当化できない。
- RRF式は`1/(60+rank)`に信号weightを乗じて加算。weight=0.1は標準BM25の順位寄与を1とし、title-only順位寄与だけを0.1にした。
- 全文書を再トークン化してランキングを揃え、タイトルtoken多重集合が全テキストtokenの部分多重集合であることを既存の評価器で検証している。

## 再現

- 評価器: `scripts/bench/benchmark_beir_bm25f_title_transfer.ts`
- 等重み結果: `quality/e2e/artifacts/scifact-train-bm25-title-only-rrf-20261023.json`
- Movies開発データから固定転移したweight=0.1結果: `quality/e2e/artifacts/scifact-train-bm25-title-only-rrf-w01-20261023.json`
- input corpus/query/qrels SHA-256、queryごとの指標、対応bootstrap区間はJSONに保存。
- `npm.cmd run typecheck` と `npx.cmd vitest run tests/bm25_adaptive.test.ts --pool=threads --fileParallelism=false` は成功。
- 本番ランキング、ユーザーDB、カード、Readerは変更していない。commit/pushなし。

## 未実施事項

TREC-COVID全171,332文書の再トークン化は約33文書/秒と計測され、85分超の見込みで中断した。既存SQLiteは全体term TFだけで、タイトル別TFを保持していないため、直ちに同方式へ流用できなかった。TREC-COVIDの既存qrelsは50クエリが1つの正解共有クラスタに連結され、推論単位としても弱い。この未完了試行から精度結果は報告しない。
