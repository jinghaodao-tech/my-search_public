# JQaRA weighted RRF追試: SHA-256順位1001–1500

登録: 2026-10-24 JST  
状態: 完了。対象query block、方式、主指標、判定基準を結果確認前に固定し、一度だけ評価。

## 目的

標準BM25にE5順位を加える重み付きRRFが、前のJQaRA test blockに未使用の質問でも改善するかを評価する。BM25:E5の重み0.5:1.0はFiQA developmentで選択済みの値を固定転移し、このJQaRA blockで調整しない。先行JQaRA 1–1000問の等重みRRF結果は既知であり、本試験は方式選択の独立再現ではなく、重み付き方式の未使用qid上の固定追試である。

## 固定対象と方式

- 原本: `hotchpotch/JQaRA` revision `e8016f8cf40f2fd51145be618ebc5a0963831d42` のtest Parquet。
- 対象: distinct `q_id`をSHA-256(`q_id`)昇順に並べた1001–1500番の500問。全100候補と公式ラベルをそのまま使う。
- 対象固定値: test Parquet SHA-256 `866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe`。qid集合SHA-256 `136c72a989a3f544bb68fa338531703450d09601736f2db9a565697bff9a6c20`。500問・50,000候補行・47,622 unique passage・4,780 positive labels。hash順先頭/末尾qidは`QA20CAPR-1492` / `QA20QBIK-1134`。
- 標準対照: Kuromoji形態素トークンによるOkapi BM25、`k1=1.2, b=0.75`、各queryの候補集合内統計。
- 主候補: 同一100候補をE5 q8で採点し、rank fusion `0.5/(60+BM25 rank) + 1/(60+E5 rank)`。重み固定後は変更しない。
- 副候補: E5単独、等重みRRF `1:1, k=60`。
- 解析、候補集合、embeddingモデル、ラベル、重み、RRF定数を結果に応じて変更しない。

## 指標と判定

- 主指標: weighted RRF−standard BM25のnDCG@10差。
- 主成功条件: 平均差>0かつ共有positive passageでクラスタ化したpaired bootstrap 20,000回の両側95% CI下限>0。
- 追跡: Hit@1/10、MRR@10、MAP@100、Recall@100、p50/p95、embedding作成時間、モデル/ベクトル容量、RSS/heap。
- timeout/エラーは成功に数えず、qrelsを補完しない。

## 制約

これはJQaRA test split内の別qid blockだが、同じ出典・同じ固定100候補タスクであり、別コーパスや製品保存カードの一般化を示さない。候補がdense retriever群から構成されるためsemantic方式に選択バイアスがあり得る。ユーザーDB、本番ランキングは変更せず、commit/pushしない。

## 事前結果確認

結果は`quality/e2e/artifacts/jqara-weighted-rrf-1001-1500-20261024-preregistered.json`に保存した。

## 結果

主指標のweighted RRF−standard BM25 nDCG@10差は`+0.069769`、共有positive passageでクラスタ化したpaired bootstrap 20,000回の両側95% CIは`[+0.050992,+0.088772]`（486 clusters）。事前登録した成功条件を満たした。

| 方式 | nDCG@10 | Hit@1 | Hit@10 | MRR@10 | MAP@100 | Recall@100 |
|---|---:|---:|---:|---:|---:|---:|
| 標準BM25 | 0.439177 | 0.524 | 0.916 | 0.656376 | 0.386684 | 1.000 |
| E5単独 | 0.468172 | 0.570 | 0.912 | 0.690833 | 0.411737 | 1.000 |
| 等重みRRF | 0.510136 | 0.640 | 0.936 | 0.746634 | 0.449215 | 1.000 |
| 固定weighted RRF (BM25 0.5 : E5 1.0) | 0.508946 | 0.630 | 0.936 | 0.735489 | 0.447338 | 1.000 |

weighted RRFのBM25比nDCG差は正だが、等重みRRFの点推定`0.510136`よりweighted RRFは`0.508946`とわずかに低い。従って「固定weighted RRFがBM25を上回る」結果であり、重み0.5:1.0が最適、または等重みより優れる証拠ではない。Recall@100が全方式1.0なのは候補が各queryの公式100件に固定されているためで、全コーパスの候補検索能力を示さない。

レイテンシp50/p95: BM25 `1.75/2.51 ms`、E5クエリ埋め込み+100候補採点`9.67/13.02 ms`、融合合計`11.61/15.14 ms`。47,622 passageの埋め込み構築は`1,734,789 ms`（約28分55秒）。モデルファイル`118,308,185 bytes`、ベクトル`73,147,392 bytes`、測定終了時RSS/heap`2,081,136,640/472,027,752 bytes`。

## 解釈

このブロックは同じJQaRA test split・同じWikipedia 100候補固定rerankingタスクの、事前固定した別qid群である。別コーパスでの再現や全文検索ではない。ラベルは自動生成・評価を含み、部分的な人手確認にとどまる。製品既定ランキングは変更しない。
