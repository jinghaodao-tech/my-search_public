# JaCWIR E5/RRF再現確認: 未使用query 2201–2700

登録: 2026-10-24 JST  
状態: このブロックのクエリ文字列・qrels・順位結果の評価前に固定

## 目的と位置づけ

先行するJaCWIR 701–1200と1201–1700ブロックでは、固定したBM25候補内E5 rerank/RRFが標準BM25より高いnDCG@10を示した。今回は同じ方式を次の未使用500問へそのまま適用し、同一公開データ源内で方向が続くかを確認する。候補選択は既知結果に基づくため、これは outcome-informed replication であり、別データ源による独立確認・製品性能の認定ではない。

## 対象と固定方式

- 出典: ローカルに取得済みの`hotchpotch/JaCWIR` `eval-00000-of-00001.parquet`および`collection-00000-of-00001.parquet`。原本は変更しない。
- 対象: distinct queryをSHA-256(query)昇順に並べた2201–2700番目の500問。各queryの公開known-positive judgementをすべて使い、qrelsを編集しない。
- 文書: 同JaCWIRコーパス全513,107件。既存の隔離BM25インデックスを使う。
- 共通解析: 既存の`purposeWords()` / `analyzeQuery()`、Kuromoji形態素トークン。方式間で同一にする。
- 対照: 全コーパス標準形態素BM25、`k1=1.2`,`b=0.75`。
- E5 rerank: `multilingual-e5-small` q8で標準BM25上位100件だけを再順位付け。
- RRF: 同じ上位100件上でBM25とE5順位を等重み、`k=60`で融合。モデル・重み・候補深度・parserを変更しない。

## 指標と判定

- 主指標: known-positive qrelsに対するnDCG@10、主比較はRRF−標準BM25。
- 副指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、BM25候補再現率、p50/p95検索時間、Embedding作成時間・容量、RSS/heap。
- 正例文書を共有するクエリを連結成分にし、対応ありcluster bootstrap 20,000回、両側95% percentile CIを出す。
- 再現基準: RRF−標準BM25のnDCG@10点推定が正で、95% CI下限が0より大きいこと。
- 同一ブロックで候補やパラメータを選び直さない。結果を見て再実行・調整しない。

## 制約

JaCWIRは生成モデル由来の質問とknown-positive中心のqrelsであり、実利用者の自然な保存記事検索ではない。positiveでない未判定文書を非関連とみなす指標は網羅的判定ではない。今回の結果は同じソース内の再現に限り、一般利用者や別コーパスへの安定優位を示すものではない。ユーザーDB、カード、メモ、Readerを使用・変更せず、commit/pushもしない。

## 実行結果

- 対象500問、全513,107文書、正例qrel 500件、query-positive連結cluster 500個。positiveはすべてコーパス内。
- 標準BM25 nDCG@10 `0.785552`、Hit@10 `0.858`、Recall@100 `0.924`。
- E5-RRF nDCG@10 `0.823791`、Hit@10 `0.890`、Recall@100 `0.924`。
- 主比較RRF−BM25 nDCG差 `+0.038239`、paired cluster bootstrap 20,000回の両側95% CI `[+0.024807,+0.051987]`。事前基準を満たす。
- BM25上位100候補のknown-positive再現は`462/500 = 0.924`。38問は候補内に正解が無く、rerank/RRFでは回復できない。
- 検索p50/p95: BM25 `24.43/105.07 ms`、RRF `33.57/113.15 ms`。候補文書Embedding初回生成 `863,384 ms`、候補ベクトル約`71.1 MB`、モデル約`118.3 MB`、測定終了RSS約`1.60 GB`。
- 結果JSON: `quality/e2e/artifacts/jacwir-full-retrieval-e5-rerank-500q-2201-2700-20261024-preregistered.json`。
- これは同じJaCWIRデータ源内の4番目のhash query blockにおける再現であり、別コーパスや実利用の独立確認ではない。
