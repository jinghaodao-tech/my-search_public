# JQaRA 日本語再ランキング比較の事前登録

登録: 2026-10-24 JST  
状態: 実行前に出典revision、対象split、方式、主指標、判定条件を固定。下記の事前登録修正後に500問を一度だけ実行。

## 目的と位置づけ

JaCWIRとは独立した日本語データ出典で、BM25とE5系semantic retrieval/fusionを比較する。JQaRAは全コーパス検索ではなく、各queryに対して固定された100候補内のrerankingタスクである。結果をmy-searchの全文検索や実利用カード再発見率に一般化しない。

## 固定データ

- 出典: `hotchpotch/JQaRA`、revision `e8016f8cf40f2fd51145be618ebc5a0963831d42`。
- split: 公開`test-00000-of-00001.parquet`のみ。dev/unusedを混ぜない。
- 対象query: 全1,667問から`SHA-256(q_id)`昇順の先頭500問を選ぶ。選択はランキング実行前に固定し、各選択queryの全100候補と全公式relevance gradeを維持する。候補・query・ラベルを編集しない。
- 残り1,167問はこの評価で使用せず、将来の未使用確認用に保留する。
- 保存: `quality/e2e/local/jqara/`。元DB・本番検索索引にはインポートしない。
- 主結果は、配布されたqueryごとの100候補集合に対するrerankingに限定する。候補生成Recallはこのデータでは比較できない。
- JQaRAの質問はJAQKET由来、文書はWikipedia 400文字以下のpassage。正解ラベルは自動規則、LLM評価、一部人手確認で作られたもので、完全な人手判断ではない。question/answerはCC-BY-SA-4.0、Wikipedia title/textはCC-BY-SA-4.0またはGFDLとして扱う。

## 固定する方式

同じquery・同じ100候補・同じrelevance labelsで以下を比較する。

1. Standard BM25: multilingual-E5を使わない標準Okapi BM25、`k1=1.2, b=0.75`。日本語語境界は既存の`tokenizeMorphological()`で固定する。
2. E5 dense: `Xenova/multilingual-e5-small` q8、384次元、query/passsage prefix、mean pooling、L2 normalization。各queryの候補100件を全件スコアし降順にする。
3. Equal RRF: 方式1と2の順位を`k=60`で等重み融合する。

クエリ解析やモデル設定、候補数、RRF係数はtest結果を見て調整しない。未登録の探索方式はtest上で追加比較しない。

## 指標と統計

- 主指標: nDCG@10。主比較はEqual RRF−Standard BM25。
- 追跡指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、p50/p95 latency、モデル初回ロード・passage/query embedding時間、RSS/heap。
- 正例passageを共有するqueryを連結成分クラスタとして対応ありbootstrap 20,000回、両側95% percentile CIを算出する。併せてquery単位bootstrapを感度分析として出す。
- 追試成功条件: nDCG@10差の点推定が正、かつcluster CI下限が0より大きい。これをもってもJQaRA内のreranking改善とだけ解釈する。
- timeout/例外は成功扱いせず、欠損・除外数と理由を報告する。公開test splitは一度だけ集計する。

## 事前に固定した制約

JQaRA候補プールは複数embedding retrieverの結果を元に構築されているためdense retrieval系に選択バイアスを含みうる。BM25、E5双方に同じ100候補を渡すことでreranker比較は揃えるが、全コーパスのcandidate generation優位を評価したことにはならない。既存benchmark結果を見てのモデル選定は避けられず、これは確認的な完全独立研究ではなく、方式比較の事前固定評価として扱う。ユーザーデータは使わず、製品ランキング変更・commit・pushをしない。

## 事前登録修正 (2026-10-24、ランキング出力を確認する前)

初回の全1,667問計画で14.4万unique passageすべてをembeddingする計算が開始されたが、実測進捗は約2,000 passage/分だった。初回処理はランキング計算・評価結果出力前に中断した。可用な計算時間との不釣り合いを理由に、評価対象を事後スコアを見ずに固定できるSHA-256先頭500問へ縮小する。残る1,167問は今回の処理に渡さず、未使用のまま保持する。データsource、主比較、モデル、candidate pool、指標、bootstrap判定条件は変更しない。中断処理の部分vector cacheは評価結果として使わない。

## 実行結果

- 原本SHA-256: `866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe`。revisionは上記固定値。
- 全split検証: 1,667 query、166,700候補行。選択500 query、50,000候補行、47,735 unique passage、positive labels 4,860。qid集合SHA-256: `9bf4c13add54af8aa7fc9f73b484caaa540f390018ec1017103161c5c5f4e408`。未使用1,167問。
- Standard BM25: nDCG@10 `0.444846`, Hit@1 `0.532`, Hit@10 `0.924`, MRR@10 `0.664595`, MAP@100 `0.384822`, Recall@100 `1.000`。
- E5 dense: nDCG@10 `0.482001`, Hit@1 `0.616`, Hit@10 `0.920`, MRR@10 `0.714606`, MAP@100 `0.420608`, Recall@100 `1.000`。
- Equal RRF: nDCG@10 `0.534133`, Hit@1 `0.684`, Hit@10 `0.938`, MRR@10 `0.778013`, MAP@100 `0.465058`, Recall@100 `1.000`。
- 主比較RRF−BM25: `+0.089288`, 478 positive-passage connected clusters, paired bootstrap 20,000回の95% CI `[+0.072896,+0.105561]`。事前基準を満たした。
- Latency p50/p95: BM25 `1.89/2.82 ms`; E5 query embedding + 100候補score `10.30/15.33 ms`; BM25+E5+RRF合計 `12.33/17.95 ms`。query embedding単体`9.92/14.64 ms`。初回model load `1,275 ms`。
- 47,735 passage embeddingの初回構築`1,817,853 ms`（約30分18秒）、ベクトル`73,320,960 bytes`、モデル`118,308,185 bytes`。終了RSS`2,091,474,944 bytes`、heap`441,129,896 bytes`。
- 結果: `artifacts/jqara-standard-bm25-e5-reranking-20261024-500q.json`。実装: `scripts/bench/benchmark_jqara_reranking.ts`。
- 解釈: 別出典の固定候補rerankingでE5/RRFの改善が得られた。これは全コーパス候補生成の評価ではなく、dense retrievalで構築された候補集合に選択バイアスがあり得る。my-search製品クエリへの一般化は未確認。

