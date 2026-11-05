# JaCWIR E5/RRF追試: 未使用query 3201–3700

登録: 2026-10-24 JST  
状態: 結果JSON生成前に対象範囲・方式・主指標・判定基準を固定済み

## 目的と位置づけ

JaCWIRの先行評価で確認されたBM25候補内rerankの改善が、次の未使用質問ブロックでも続くかを測る。JaCWIR内では方式選択と複数の追試が既に行われているため、本試験は同一データ源内の事前固定追試であり、別データ源による独立再現でも実利用性能の証明でもない。

## 固定する評価条件

- 出典: 取得済み`hotchpotch/JaCWIR`原本Parquet。原本は読み取り専用で扱う。
- 対象: distinct queryをSHA-256(query)昇順に並べた3201–3700番の500問。選択後、順位結果を見る前にqid集合・SHA-256を記録する。
- 固定済み入力: 500 qidは全て一意、先行11スライスの3,100 qidとの重複は0。`queries.jsonl` SHA-256 `98fa3160b0db6f8ffda30855a795ede71269ea8703d348f223a8a8e15a4e5a5f`、`qrels.jsonl` SHA-256 `74b9cbb2637d5a65dedd5bdb92b207757fa2e9a923ef2e5c1910ef8e809567d9`、`manifest.json` SHA-256 `79b5f216975da53237a05082861bdb165c95f4ccb8ed776cdd9c569248329f91`。qrelsは504件（504 unique query-document pairs）。
- 各queryの公開positive judgmentを全件使用し、query・正解・順位による選別や編集をしない。
- コーパス: 全513,107文書。既存の隔離SQLite形態素転置索引を読み取り専用で使う。
- 共通検索解析: `purposeWords()` / `analyzeQuery()` とNFKC後のKuromoji形態素トークン。
- 対照: 全文書標準形態素BM25、`k1=1.2`、`b=0.75`。
- 主方式: 同一BM25 Top-100候補内でBM25順位と`multilingual-e5-small` q8順位を等重みRRF、`k=60`で融合。
- 副方式: 同じBM25 Top-100候補内のE5単独再順位付け。結果を見て主方式と入れ替えない。
- モデル、tokenizer、parser、候補深度、スコア方式は変更しない。

## 指標と判定

- 主指標: 公式known-positive qrelsに基づくnDCG@10のRRF−標準BM25差。
- 追跡指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、Top-100候補再現率、p50/p95、Embedding生成時間、モデル・ベクトル容量、RSS/heap。
- 正例文書を共有するqueryを連結成分単位で扱い、対応ありcluster bootstrap 20,000回、両側95% percentile CIを算出する。
- 追試成功条件: 主差の点推定が正、かつ95% CI下限が0より大きい。
- timeout/実行エラーは成功に数えず、全件を報告する。qrelsを補完しない。

## 実行結果

- 実行: 500問、positive qrel 504件。query-positive共有クラスタ500。
- 標準BM25: nDCG@10 `0.812812`、Hit@1 `0.738`、Hit@10 `0.888`、MRR@10 `0.788732`、MAP@100 `0.791247`、Recall@100 `0.952`。
- E5 rerank: nDCG@10 `0.846285`、Hit@1 `0.752`、Hit@10 `0.928`、MRR@10 `0.819475`、MAP@100 `0.820777`、Recall@100 `0.952`。
- 等重みRRF: nDCG@10 `0.851388`、Hit@1 `0.770`、Hit@10 `0.922`、MRR@10 `0.828154`、MAP@100 `0.829689`、Recall@100 `0.952`。
- RRF−BM25 nDCG差 `+0.038576`、paired cluster bootstrap 20,000回・両側95% CI `[+0.024021,+0.053740]`。Hit@10差 `+0.034`、CI `[+0.018,+0.052]`。事前登録基準を満たした。
- BM25 Top-100候補再現率 `476/500=0.952`。24問は候補外で、rerankingでは回収できない。
- 検索p50/p95: BM25 `15.997/72.837 ms`、E5 `23.469/80.803 ms`、RRF `23.553/80.900 ms`。
- 新規46,239候補のembedding構築 `830,978 ms`（約13分51秒）、候補ベクトル`71,023,104 bytes`、q8モデル`118,308,185 bytes`、終了RSS/heap `1,666,605,056/727,474,192 bytes`。CPU実行。
- 結果JSON: `quality/e2e/artifacts/jacwir-full-retrieval-e5-rerank-500q-3201-3700-20261024-preregistered.json`。
- 解釈: 事前登録した同一JaCWIR内の追試条件を満たす。保存カード検索や実利用者に対する一般化ではない。

## 解釈上の制約

JaCWIRの質問は元記事から生成された評価用質問で、qrelsは全コーパスの網羅的関連判定ではない。指標は既知正例の検索に限る。文書はタイトルと概要であり記事全文ではない。成功しても同一データ源内の追試に限り、保存カード検索や実利用者の成功率を主張しない。ユーザーDB、カード、メモ、Readerは使用・変更せず、commit/pushもしない。
