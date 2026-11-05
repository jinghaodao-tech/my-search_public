# BM25Fタイトル重みのMovies転移確認計画

## 固定候補

Books開発分割で選ばれた `titleWeight=2.0`、`titleB=0.3`、`bodyWeight=1.0`、`bodyB=0.75`、`k1=1.2` を変更せず、Reddit-TOMT Movies developmentへ適用する。候補・方向・パラメーターはMovies結果を見て調整しない。

## 比較・判定

- 標準BM25 `k1=1.2,b=0.75` と固定BM25Fのみを同じ文書、クエリ解析、ラベル、候補集合で比較する。
- nDCG@10を主要指標とする。補助指標はHit@1/10、Recall@100、MRR@10、MAP@100。
- target itemのクラスタ単位paired bootstrap 95%区間を出す。
- Booksで事前登録した継続条件（nDCG差>=0.005、95%区間下限>0）をそのまま使う。
- Movies developmentは既に他方式の探索に使用済みなので、これは**転移診断であり独立・未使用のconfirmatory holdoutではない**。条件を満たしても安定した優位性の認定には使わない。
- 本番ランキングは変更しない。
