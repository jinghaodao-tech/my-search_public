# QueryAnalysis重み付きBM25 独立評価計画

## 仮説

TOMT Booksの探索的developmentで、既存`analyzeQuery()`の重みをBM25語寄与に適用するとHit@10を変えずにMRR・nDCG・MAPが小幅改善した。既存コードが既に表す検索意図重みを、標準BM25へ組み合わせた固定候補として、別タスク2つで一度だけ検証する。

## 固定方式

- 基準: Kuromoji morphology tokensを使うBM25、`k1=1.2`、`b=0.75`、positive-smoothed IDF。
- 候補: 同じBM25で各一致語の寄与に`analyzeQuery().keywords[].weight`を乗算。重みは既存のQueryAnalysis出力そのまま。新規係数調整なし。
- 共通: `purposeWords()`、`analyzeQuery()`、全文コーパス、候補集合、文書トークン・文書長、qrelsを共有。
- FTS、RRF、時間減衰、他の補正は加えない。

## 独立データ・指標

- BEIR公式CQADupStack `test` 全コーパス。
- BEIR公式Webis-Touche2020 `test` 全コーパス。
- 主指標: nDCG@10。補助: MRR@10、Hit@10、Recall@100、MAP@100。
- 正例qrelの連結成分によるcluster bootstrap 95%区間。
- **安定優位**の判定: 両データセットでnDCG@10差の95%区間下限>0、MRR@10も明確に悪化せず、Hit@10/Recall@100の大幅な低下がない場合のみ採用候補とする。
- Self-qrel `queryId == documentId` はBEIR標準の扱いに従って除外し、数を報告する。正例qrelのないクエリは主評価から除外して数を明記。
- コーパス・クエリ・qrels・方式・係数を結果に合わせて変更しない。2データセットを他方式の再調整に再利用しない。

## 保全

- 原本・展開コピー・索引は`data/ir_benchmark/work/beir-query-weight-independent-20261023/`内に隔離。
- プロダクトDB、カード、メモ、Readerには接続しない。本番ランキングは変更しない。
- SHA-256、公式配布MD5、評価器指紋、速度・メモリを成果物に記録する。
- commit/pushなし。
