# Movies開発分割・重み付きRRFクロスドメイン確認

## 目的と位置づけ

Books開発分割で事後探索した `BM25:FTS5-RRF = 1:0.1` を、別ドメインのMovies開発分割で一度だけ確認する。これはBooks結果を受けた探索的なクロスドメイン確認であり、未使用の最終ホールドアウトでも、my-searchの記事再発見性能の独立認定でもない。Moviesの既使用holdout・validationの結果は使用しない。

## 固定データ選択

- データ: Reddit-TOMT Movies `development.jsonl`、正規化済みコーパスSHA-256 `99cafecf4432dfe6c5677774cf92cbce9b9ab570823edfe39454718c2b91296a`
- 全Movies文書を隔離SQLiteへ登録し、検索APIを通す。
- 開発クエリから、`SHA-256(group_id)` の辞書順で先頭500の正解対象グループを選ぶ。
- 各グループから、`SHA-256(group_id + NUL + query_id)` の辞書順で先頭のクエリを1件選ぶ。
- API経路のスモーク試験で先に観測したハッシュ順先頭2グループは除外し、offset=2から次の500グループを採る。
- クエリ、ラベル、またはランキング結果を使った選別はしない。

## 固定比較

- 比較対象: 現行アプリBM25と、同じBM25/FTS5-RRF二つのTop50をRRF定数60、BM25重み1、FTS5重み0.1で融合した順位。
- 融合重み1:0.1はBooks開発データの探索後に固定し、Movies結果を見て変更しない。
- パーサー、全文書集合、フィルタ、API、正解ラベル、検索語は同じにする。
- この確認データで重みを再調整しない。改善が見られなくても別設定を試さない。
- 主指標: Hit@10。補助: Hit@1、MRR@10、nDCG@10、APIレイテンシ。
- 対応比較の不確実性は正解対象グループ単位の10,000回ブートストラップ95%区間で示す。
- エラーは成功扱いせず、件数と発生内容を報告する。

## 実行と限界

実行コマンド:

```powershell
node_modules\.bin\tsx.cmd scripts\benchmark_tomt_saved_card_search.ts data\movies-dev-bm25-vs-rrf-20261022.sqlite quality\e2e\artifacts\movies-dev-bm25-vs-rrf-20261022.json --dataset=movies --sample-groups=500 --sample-offset=2 --reuse-isolated-db
```

この結果はReddit上の映画想起課題に限る。検索対象は映画タイトルと利用可能な説明文であり、技術記事・保存カードの代表データではない。開発分割から作った結果であるため、独立最終評価とは呼ばない。
