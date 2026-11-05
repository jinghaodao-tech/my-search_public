# BM25Fタイトル重みの比較結果

## 判定

**本番採用しない。** Books developmentで選択した `titleWeight=2` のBM25Fは、BooksとMoviesの両方でnDCG@10の点推定が標準BM25を上回った。しかし、Booksは差が小さく事前基準未達、固定候補を適用したMoviesでも差の95%区間が0を含んだ。安定した優位性は確認できていない。本番検索・DBスキーマは変更していない。

## 方式

- 標準: positive-smoothed BM25、k1=1.2、b=0.75、タイトル+本文を連結した既存形態素トークン。
- BM25F: k1=1.2、title weight=2、title b=0.3、body weight=1、body b=0.75。IDF、クエリ解析、検索語、候補集合、正解ラベルは共通。
- Booksではtitle weight `{1,1.5,2}` を開発探索し、nDCG@10で2を選択。MoviesではBooksで選んだ2を固定し、Movies上で再選択していない。
- 各target groupにつきクエリ1件をSHA-256で選択。区間はtarget-group paired bootstrap 95%、各20,000回。
- SQLiteは読み取り専用。ソースの文書ID・タイトル・本文がDBと一致することを全件確認。タイトルをアプリの形態素解析器で解析し、その語頻度がDB保存済み連結トークン頻度の部分多重集合であることを検証。本文頻度は残差として計算。

## 結果

| 分割 | 方式 | Hit@10 | Recall@100 | MRR@10 | nDCG@10 | MAP@100 |
|---|---|---:|---:|---:|---:|---:|
| Books dev (1,528 groups) | 標準BM25 | 0.37042 | 0.60864 | 0.23817 | 0.26949 | 0.24654 |
| Books dev | BM25F title=2 | 0.37107 | 0.61518 | 0.24284 | 0.27324 | 0.25152 |
| Movies dev (7,086 groups) | 標準BM25 | 0.25388 | 0.42774 | 0.15702 | 0.18002 | 0.16312 |
| Movies dev | BM25F title=2（固定） | 0.25430 | 0.42704 | 0.15762 | 0.18058 | 0.16369 |

両ドメインを等重みで平均し、ドメイン内target groupを層別再標本化した探索的集計では、nDCG@10差は+0.00216、95% CI `[-0.00009,+0.00442]`。MAP@100差は+0.00278、95% CI `[+0.00038,+0.00526]`、MRR@10差は+0.00264、CI `[+0.00024,+0.00502]`。ただし主指標nDCGは依然0を含む。MAP/MRRは事前に定めた主指標ではなく、探索的な二次指標として扱う。

| 分割 | nDCG@10差 | paired cluster bootstrap 95% CI | 事前継続基準 |
|---|---:|---:|---|
| Books dev | +0.00376 | [-0.00054, +0.00805] | 未達（必要差>=0.005、下限>0） |
| Movies dev | +0.00056 | [-0.00058, +0.00175] | 未達 |

## 解釈・限界

- BooksではHit@1/10、Recall@100、MRR、nDCG、MAPの点推定がいずれも小幅上昇したが、主要指標nDCGの区間が0をまたいだ。
- MoviesではnDCG/MRR/MAPがごく小幅に上がった一方、Recall@100は低下。主要指標の区間も0をまたいだ。
- Movies developmentは別ドメインへの固定候補転移診断だが、同データは過去に他方式の探索で使用済みである。未使用の独立確認データとは呼べない。
- レイテンシ計測は単一プロセス内で方式を順次実行した探索値。Books nDCG比較では標準p50/p95=1.54/3.17 ms、BM25F=1.06/1.99 ms。Movies固定比較では標準=14.75/29.62 ms、BM25F=13.97/28.91 ms。これらは候補ごとの独立ベンチマークではなく、速度優位の主張には使わない。
- Books候補選択とMovies転移を含む開発・既使用データであり、最終的な優位性認定には未使用の独立コーパス・クエリが必要。

## 成果物と再現

- Books計画: `quality/e2e/docs/BM25F-TITLE-BOOST-BOOKS-DEV-PLAN-2026-10-23-ja.md`
- Movies固定評価計画: `quality/e2e/docs/BM25F-TITLE-BOOST-MOVIES-TRANSFER-PLAN-2026-10-23-ja.md`
- Books全クエリ結果: `quality/e2e/artifacts/books-dev-bm25f-title-20261023.json`
- Movies固定候補結果: `quality/e2e/artifacts/movies-dev-bm25f-title-transfer-20261023.json`
- 実行器: `scripts/bench/benchmark_tomt_bm25f_title.ts`
- equal-domain集計器: `scripts/bench/summarize_bm25f_domain_macro.ts`
- equal-domain集計結果: `quality/e2e/artifacts/bm25f-title-domain-macro-20261023.json`

```powershell
npm.cmd run typecheck
node_modules/.bin/tsx.cmd scripts/bench/benchmark_tomt_bm25f_title.ts quality/e2e/data/reddit_tomt/books quality/e2e/.runtime-tmp/phase2-books/benchmark.db quality/e2e/artifacts/books-dev-bm25f-title-20261023.json
node_modules/.bin/tsx.cmd scripts/bench/benchmark_tomt_bm25f_title.ts quality/e2e/data/reddit_tomt/movies quality/e2e/.runtime-tmp/mysearch_tomt_isolated__u_e8340/benchmark.db quality/e2e/artifacts/movies-dev-bm25f-title-transfer-20261023.json --fixed-title-weight=2
```
