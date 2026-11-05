# BM25 k1/bグリッド: Books開発比較計画

## 仮説と範囲

既定BM25 `k1=1.2,b=0.75` がTOMT Booksの語頻度・文書長分布に最適とは限らない。既存トークナイズ、クエリ解析、候補集合を固定し、BM25パラメータだけを開発データで探索する。結果は探索的で、独立評価前に製品方式を変更しない。

## 固定グリッド・選択法

- `k1 ∈ {0.8, 1.2, 1.6}`。
- `b ∈ {0.25, 0.5, 0.75, 1.0}`。
- positive-smoothed IDF、既存のKuromoji morphology tokensと文書長、既存`purposeWords()`/`analyzeQuery()`、同じ候補集合。
- TOMT Books developmentでtarget groupごとにSHA-256固定選択した1クエリを使う。選択に正解や順位を使わない。
- 主要な選択指標はnDCG@10。最良のnDCGを選び、同値ならMRR@10、次に既定値(1.2,0.75)への近さで決める。
- 12通りの探索結果は多重選択を含むdevelopment結果として扱う。改善を主張せず、ホールドアウト候補の選定だけに使う。
- 候補を次へ進める条件: nDCG@10差>=+0.005かつtarget-group bootstrap 95%区間下限>0、Hit@10/Recall@100に大きな退行がない。満たさない場合は全候補棄却。

## 保全

隔離された既存TOMT Books評価DBを読み取り専用で開く。本番DB・ランキング・ユーザーデータを変更せず、commit/pushしない。
