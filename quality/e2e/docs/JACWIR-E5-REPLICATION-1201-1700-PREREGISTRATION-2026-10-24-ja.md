# JaCWIR再現確認: 未使用query 1201–1700 事前登録

登録: 2026-10-24 JST  
状態: 対象query・正解・順位結果の確認前に固定  
目的: 701–1200で確認されたBM25+E5/RRF差が、次の未使用JaCWIR query blockでも同じ方向に再現するか確認する。

## 対象

- 出典: 取得済み`hotchpotch/JaCWIR`公開データ`eval-00000-of-00001.parquet`、`collection-00000-of-00001.parquet`。
- 全distinct queryをSHA-256(query)昇順に並べた1201–1700番目の500問。既評価query IDとの重複を禁止する。
- 513,107件の全コーパスを対象とする既存の隔離BM25 indexを再利用する。
- 各対象queryの公開データに含まれるすべてのpositive judgementを保持し、評価後にqrelsを変更しない。
- JaCWIR qrelsはknown-positiveのみであり、未判定文書を非関連とみなす指標は網羅的適合判定ではない。

## 固定方式

- Standard BM25: Kuromoji形態素解析、NFKC、`k1=1.2`、`b=0.75`、全コーパスexact Top-100。
- E5 rerank: `multilingual-e5-small` q8で同一BM25 Top-100のみを再順位付け。
- RRF: 同一候補集合内のBM25/E5順位を等重み、`k=60`で融合。
- 主候補をRRFとして固定。結果による候補深度・モデル・係数・query parser・指標の変更はしない。

## 主評価・判定

- 主指標: binary known-positive nDCG@10。主比較は`RRF − BM25`。
- 副指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、候補再現率、p50/p95レイテンシ、候補Embedding容量、RSS/heap。
- positive文書を共有するquery群は連結成分でまとめ、paired cluster bootstrap 20,000標本から両側95% percentile CIを出す。
- 再現成功の事前基準: RRF−BM25のnDCG@10 CI下限が0より大きい。
- 本500問は一度だけ実行する。途中停止・選択・係数調整をせず、未達なら未達と報告する。
- 評価対象は全コーパスBM25候補生成と同一候補内semantic rerankingの構成。Embedding構築時間は検索レイテンシと別に報告する。

## 解釈範囲

この結果は同一公開データ源における別のquery splitであり、JaCWIRとは独立なデータセットではない。JaCWIRの質問は実利用者の自然検索ログではなく、文書はWebページのタイトルと概要である。結果を保存記事の実利用・一般ユーザーの成功率へ一般化しない。
