# JaCWIR未使用クエリ601–700でのBM25/E5比較 事前登録

登録: 2026-10-24 JST  
状態: 対象クエリ本文・正解・順位結果の確認前に固定  
目的: JaCWIRの既評価ブロック（1–600）と重ならない質問で、標準BM25に対するE5再順位付けと等重みRRFの再現性を測る。

## 対象と選択

- 出典: `hotchpotch/JaCWIR` の既取得 `eval-00000-of-00001.parquet` および `collection-00000-of-00001.parquet`。
- 対象母集団: distinct query stringをSHA-256(query)昇順にした601–700行目の100問。既評価1–600行目は含めない。
- 文書コーパス: 全513,107文書。既存の隔離BM25索引とその固定コーパスを再利用し、ユーザーDBは使わない。
- 正解: 対象質問に対応する公開ソースの全positive judgement。正解や文書を結果を見て追加・削除しない。
- 出典qrelsは全コーパスの網羅的判定ではない。したがって指標は既知正解の順位・取得率であり、網羅的適合率とは呼ばない。

## 比較方式

- 共通BM25第1段: Kuromoji形態素解析、NFKC、`k1=1.2`、`b=0.75`、全文書からexact Top-100。
- BM25基準: 上記Top-100の順位。
- E5再順位付け: `multilingual-e5-small` q8、同じBM25 Top-100候補だけを再順位付け。
- RRF: 同候補内でBM25順位とE5順位を等重み、`k=60`で統合。係数調整はしない。
- E5モデル、tokenizer、query parser、索引、候補深度、評価指標は評価結果を見て変更しない。

## 指標・判定

- 主指標: known-positive binary nDCG@10。
- 副指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、BM25候補再現率、p50/p95レイテンシ、Embedding容量、RSS/heap。
- 主比較: RRF − BM25のquery-paired nDCG@10。
- positive文書を共有するqueryを同一連結クラスタとして扱い、20,000回のpaired cluster bootstrapで両側95% percentile CIを算出する。
- このブロックで改善の再現を支持する条件は、主差の95% CI下限が0を上回ること。結果確認後の再実行・方式変更はこの確認試験の主張に使わない。
- レイテンシはBM25解析・posting取得・順位付け、E5 query embeddingと候補100件のスコア計算、RRF統合を含む。候補文書Embedding生成・モデル初期化は別途記録する。

## 限界

この100問は同じJaCWIR公開データ源の未使用query blockであり、独立した別データ源ではない。公開qrelsは不完全で、未判定文書を非関連として扱う。結果はJaCWIR full-corpus known-positive retrievalに限定し、保存記事の実利用者検索や全日本語検索への一般化を主張しない。
