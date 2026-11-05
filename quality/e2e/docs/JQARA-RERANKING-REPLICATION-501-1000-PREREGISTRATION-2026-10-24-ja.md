# JQaRA RRF追試: SHA-256順位501–1000

登録: 2026-10-24 JST、埋め込み・ランキング実行前  
状態: 固定済みの第二500問ブロックで一度だけ実行

## 目的

JQaRAの先行500問で確認された標準BM25対multilingual-E5-small/RRFの差が、同一データ源の次の未使用質問ブロックでも続くかを調べる。これは別出典での再現ではない。前回の1,667問全split確認でquery schemaと全件数は読んだが、501–1000ブロックのランキング指標はまだ計算していない。

## 固定対象・方法

- 原本: `hotchpotch/JQaRA` revision `e8016f8cf40f2fd51145be618ebc5a0963831d42`、`test-00000-of-00001.parquet`。SHA-256は主事前登録記載値を再検証する。
- query: `SHA-256(q_id)`昇順の501–1000番目（1-based）の500問。全100候補と公式ラベルをそのまま使用する。最初の500問の選択・結果はこの選択に使わない。
- 未使用評価: 残り667問は今回も実行しない。
- 選択qid集合SHA-256: `fd1b0f5857a3414baa691eef6222cdf274deb190cd32b7193e48faf58273ec0a`。選択ブロックは500問、50,000候補行、47,651 unique passage、positive labels 4,862。これらは順位指標を参照せずParquet構造から確認した。
- Standard BM25: Kuromoji morphology、Okapi `k1=1.2, b=0.75`、各queryの固定100候補内統計。
- E5: `Xenova/multilingual-e5-small` q8、384次元、`query:` / `passage:`、mean pooling、L2 normalize、同じ100候補をexact cosineで全件採点。
- Equal RRF: BM25 rankとE5 rank、`k=60`、等重み。主比較は前回から方式変更なし。
- 主指標: nDCG@10差 RRF−BM25。Hit@1/10、MRR@10、MAP@100、Recall@100、p50/p95も報告。
- 共有positive passageを持つqueryを連結成分化し、paired cluster bootstrap 20,000回の95% CIを使う。主基準は点推定>0かつCI下限>0。

## 制約

JQaRAは各質問につき公開済み100候補をrerankするタスクで、全コーパスcandidate generationを評価しない。候補は複数dense retriever由来でdense方式に選択バイアスがある。質問/文書出典と正解ラベルには自動処理および一部人手確認がある。今回の結果を保存カード検索へ直接一般化しない。係数や方式は結果を見て調整しない。ユーザーデータ・本番検索・既存DBは変更せず、commit/pushしない。

## 実行結果

- 原本SHA-256: `866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe`。qid集合SHA-256: `fd1b0f5857a3414baa691eef6222cdf274deb190cd32b7193e48faf58273ec0a`。
- 500問、50,000候補行、47,651 unique passage、positive labels 4,862。クエリクラスタ490。
- Standard BM25: nDCG@10 `0.471959`, Hit@1 `0.604`, Hit@10 `0.934`, MRR@10 `0.718198`, MAP@100 `0.408103`, Recall@100 `1.000`。
- E5 dense: nDCG@10 `0.480190`, Hit@1 `0.626`, Hit@10 `0.924`, MRR@10 `0.728309`, MAP@100 `0.411791`, Recall@100 `1.000`。
- Equal RRF: nDCG@10 `0.534177`, Hit@1 `0.686`, Hit@10 `0.944`, MRR@10 `0.773503`, MAP@100 `0.458474`, Recall@100 `1.000`。
- 主比較RRF−BM25 `+0.062217`, 20,000回paired cluster bootstrap 95% CI `[+0.045289,+0.079279]`。事前基準を満たした。E5単独差`+0.008231`、CI `[-0.015520,+0.031354]`で基準を満たさない。
- Latency p50/p95: BM25 `1.91/2.92 ms`; E5 query embedding + 100候補採点 `10.30/14.88 ms`; BM25+E5+RRF合計 `12.36/17.61 ms`。一回限りの47,651 passage embedding生成`1,833,012 ms`（約30分33秒）、ベクトル`73,191,936 bytes`、モデル`118,308,185 bytes`、終了RSS`1,942,736,896 bytes`、heap`444,255,736 bytes`。
- 結果: `artifacts/jqara-standard-bm25-e5-reranking-20261024-queries-501-1000.json`。
- 判定: 先行sample 1–500に続き、未使用501–1000でも固定equal-RRFの改善が再現した。同一JQaRA test source内の再現であり、my-search製品検索への一般化は依然未確認。
