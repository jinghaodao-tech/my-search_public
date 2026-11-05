# JaGov公式holdoutでのBM25対E5/RRF 事前登録

登録日時: 2026-10-24 JST  
状態: holdout抽出・評価前に固定  
目的: 固定した等重み `BM25 + multilingual-e5-small` RRFが、未使用のJaGov公式holdoutでも標準BM25を上回るかを一度確認する。

## データと隔離

- 公式JaGovFaqsRetrievalリビジョン: `0726b2af53c907628067871e2e7c84e0d8e099c2`。
- 固定manifestはdevelopment 614、validation 410、holdout 1,024問/1,024グループを記録する。既存の転移評価ではholdoutをエクスポートせず、holdout評価artifactもないことを確認した。
- holdoutは質問・qrelsの内容を確認せずに使用する。評価用抽出後、方式・指標・閾値は変更しない。
- 既存の全22,794回答コーパス・BM25 indexを読み取り専用で使用する。
- 固定入力SHA-256:
  - 元corpus: `0511e630f06d55a82bdd9fdb6ed096fbed3265d34081a2a7378710181b77d5fa`
  - 元queries: `b068afc7cbb6bdffa54a069b53772147bb11d373435549dd0fd2939225e66459`
  - 元qrels: `cbda10a7ef78cdbf59cf9fd48b1ed288e79fe2c7712e4c52f53dd266d083678f`
  - 元splits: `8c270c9780a16d9c9311f7f4d545e49190ec8a3c97c6d0e96de3108ea15ad3f4`
  - 変換済み全コーパス: `62526ae437e2eb180f104d0d4c6385d8e0e3ead1f8e552192b5ceceff4f8d6d0`
  - read-only BM25 index: `D91926C1B0CA47AE5CC17C38F6B403895C37310439D6493931D4ED78AF97335B`
  - 固定評価スクリプト: `F6C1C63D60FDF9682D02179DD6CCCD5A2B0771249A950835F78A2361B3C2C696`

## 固定する検索方式

- 標準BM25: Kuromoji形態素トークン、my-searchの同一 `purposeWords()` / `analyzeQuery()`、`k1=1.2, b=0.75`、全コーパスからexact Top-100。
- E5: `Xenova/multilingual-e5-small` q8、384次元、`query:` / `passage:` prefix、mean pooling、L2正規化。全コーパスのexact dense scanでTop-100を得る。
- 主候補RRF: BM25 Top-100とE5 Top-100を等重み、`k=60`で融合してTop-100を返す。
- E5単独は副次比較として記録する。重み・モデル・クエリ解析・tokenizer・検索深度の再調整はしない。
- 文書ベクトルは保存・再利用可能な既存キャッシュを使う。キャッシュ不一致時は完全一致の新規再計算のみ許し、入力内容や評価方式は変えない。

## 評価・判定

- 主指標: binary-qrel nDCG@10、主比較はRRF − BM25。
- 副指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、p50/p95、index/vector容量、RSS/heap。
- 連結正解対象クラスタを単位にした20,000回paired cluster bootstrapの両側95%区間を報告する。
- 候補方式は、点推定が正かつ95%区間下限が0を上回れば、このholdout・コーパス内での確認成功とする。多重指標から成功条件を選び直さない。
- 実行は一度。結果を見た再実行・パラメータ変更は禁止。

## 限界

これは公式FAQ質問と回答文書の検索であり、my-search利用者の保存記事再発見や人間の検索ログではない。別のholdoutソースでの再現証拠にはなるが、実利用や全ドメインの一般的優位を証明しない。全件dense scanの計算費用・モデル容量も製品実装の運用費用として別に評価する。

## 実行結果

- artifact: `artifacts/jagov-e5-rrf-holdout-1024-20261024-preregistered.json`
- BM25 nDCG@10 `0.5757`、E5単独 `0.6497`、等重みRRF `0.6363`。事前登録したRRF−BM25差は `+0.06060`、paired cluster bootstrap 95%区間 `[+0.04832, +0.07307]`、1,024クラスタ。
- Hit@10はBM25 `0.7295`、RRF `0.7832`（差 `+0.05371`、95%区間 `[+0.03613, +0.07227]`）。MRR@10は `0.5267`→`0.5892`、Recall@100は `0.8682`→`0.9131`。
- RRF検索p50/p95は `27.8/39.6 ms`、BM25は `0.74/2.18 ms`。RRF query latencyはE5 query embeddingと全文書dense scanを含み、一回限りのコーパスEmbedding生成は含まない。Embedding cache hitで構築時間は約19ms、ベクトルは35,011,584 bytes、モデルは118,308,185 bytes、プロセス終了時RSSは985,686,016 bytes。
- 元ファイルからの最初のexportは原本ID列名と評価器の期待列名の不一致で、ランキング開始前に停止した。質問・qrelsの採点結果を出していないため、変換を修正して同じ固定計画を実行した。使用した変換後コーパスSHAは事前登録値と一致した。
- これは事前登録済みの一度限りのJaGov公式holdout評価だが、既存のdevelopment/validationで等重みRRFを観測した後の確認である。結果を見た後の再調整はしていない。公式FAQ検索に対する確認であり、利用者の保存記事再発見への一般化はしない。
