# JQaRA equal-RRF追試: SHA-256順位1501–1667

登録: 2026-10-25 JST  
状態: 対象query、方式、主指標、判定基準を結果確認前に固定。

## 目的

標準BM25に multilingual-e5-small の順位を等重みRRFで加える固定方式が、JQaRA test splitの未使用末尾queryでもnDCG@10を改善するか検証する。これは同じ公開benchmarkの固定候補reranking内追試であり、独立コーパス、全文検索、my-search保存カード利用の一般化試験ではない。

## 固定条件

- 出典: `hotchpotch/JQaRA` revision `e8016f8cf40f2fd51145be618ebc5a0963831d42`、公式test Parquet SHA-256 `866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe`。
- 対象: distinct `q_id`をSHA-256(`q_id`)昇順にした順位1501–1667の残り167問すべて。選択に検索結果・qrelsスコアを使わない。全100候補と公式ラベルを保持する。
- 対照: Kuromoji morphology tokens、標準Okapi BM25 `k1=1.2,b=0.75`、queryごとの固定100候補内統計。
- 主候補: multilingual-e5-small q8、384次元、`query:`/`passage:` prefix、mean pooling、正規化cosine、BM25とE5の等重みRRF `k=60`。
- 副次記述: E5単独、BM25:E5=`0.5:1` weighted RRF。係数は変更・再選択しない。
- 検索対象候補は公式100候補のまま固定。これはreranking評価で、全コーパス候補生成の評価ではない。

## 判定

- 主指標: equal-RRF minus standard BM25の平均nDCG@10差。
- 改善基準: 差が正で、positive passage共有による連結クラスタを単位にしたpaired bootstrap 20,000 drawsの両側95% CI下限が0より大きい。
- 併記: Hit@1/10、MRR@10、MAP@100、Recall@100、クラスタ数、query p50/p95、Embedding構築時間、モデル/ベクトル容量、RSS/heap。
- 失敗・欠損・timeoutは成功として数えず、qrelsやクエリを変更しない。評価後の閾値・重み調整にこのブロックを再利用しない。

## 限界

先行qid順位1–1500は過去の方式比較に使用済みであり、本試験は候補方式を固定した未使用qid追試ではあるが、独立な方式選択や別出典での確認ではない。過去qidとpositive passageを共有する場合の重なりも結果に明記する。JQaRAは固定100候補の日本語Wikipedia QAで、候補集合の出所・自動ラベルや部分的人手確認の限界を持つ。実利用者や保存カードの成功率を示さない。

本番ランキング、既存ユーザーDB、カード、Readerを変更しない。commit/pushしない。

## 結果

評価完了。選択qid集合SHA-256は`9a80c6b7dbf56eb35fc8b35c5b1b030a9a3d47f698f2574dd6d988cefb2d2fd54`。167問・16,700候補行・16,521 unique passage・1,702 positive labels。167問中34問が過去qid順位1–1500とpositive passageを共有し、共有positive passageは88件。今回の166クラスタpaired区間は選択ブロック内の依存を反映するが、過去ブロックとの重なりを除いた独立標本区間ではない。

| 方式 | nDCG@10 | Hit@1 | Hit@10 | MRR@10 | MAP@100 | Recall@100 |
|---|---:|---:|---:|---:|---:|---:|
| 標準BM25 | 0.45100 | 0.6407 | 0.9222 | 0.73063 | 0.40302 | 1.000 |
| E5単独 | 0.43847 | 0.5928 | 0.8862 | 0.68848 | 0.39549 | 1.000 |
| 等重みRRF (主候補) | 0.51230 | 0.6407 | 0.9521 | 0.74539 | 0.44961 | 1.000 |
| 固定weighted RRF BM25:E5=0.5:1 | 0.49547 | 0.6168 | 0.9401 | 0.72495 | 0.44015 | 1.000 |

主指標の等重みRRF−BM25 nDCG@10差は`+0.061299`、166 positive-passage connected clustersによるpaired bootstrap 20,000回、両側95% CI`[+0.033854,+0.088606]`。事前判定基準を満たした。Hit@10差は`+0.029940`。E5単独はBM25比`-0.012530`（95% CI `[-0.056646,+0.031172]`）で、意味順位単独の改善は確認できない。weighted RRFも改善したが、equal RRFの点推定を上回らない。

全方式のRecall@100が1.0なのは固定100候補のrerankingであり、候補生成能力の証拠ではない。query p50/p95: BM25`1.86/2.80ms`、E5 query embedding＋採点`10.20/13.80ms`、RRF合計`12.27/16.25ms`。passage embedding構築`507,607ms`（約8分28秒）、q8モデル`118,308,185 bytes`、16,521 passageベクトル`25,376,256 bytes`、終了RSS約`1.95GB`。

### 解釈

固定候補の同一JQaRA test内で未使用qidに対する等重みRRFの順位改善が続いた。ただし、同一出典・同一100候補課題であり、34/167問が過去ブロックとpositive passageを共有する。したがってこれは既存のJQaRA証拠を補強する追試で、独立コーパス再現でも保存カード実利用の一般化でもない。候補方式として保持するが、本番既定へ自動昇格させない。

実行コード: `scripts/bench/benchmark_jqara_reranking.ts`  
結果: `quality/e2e/artifacts/jqara-equal-rrf-1501-1667-20261025-preregistered.json`
