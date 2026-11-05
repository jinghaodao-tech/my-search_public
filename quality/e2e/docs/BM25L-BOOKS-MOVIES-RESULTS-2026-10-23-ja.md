# BM25L結果（Books / Movies）

## 判定

**BM25L delta=0.5は不採用。** Books/Moviesの両方で標準BM25より大きく悪化した。Moviesは固定SHAサンプル1,500 groupだが、nDCG@10差は-0.0544で、target-group bootstrap 95%区間 `[-0.0629,-0.0460]`。Books全1,528 groupも-0.0217 `[-0.0265,-0.0172]`。本番ランキングは変更していない。

BM25Lは長文書の過度な長さペナルティを緩和する目的で提案された方式で、delta=0.5は原論文の実験設定に合わせた。[Lv and Zhai, SIGIR 2011](https://lintool.github.io/robust04-analysis-papers/p1103-lv.pdf)。このTOMT評価では、その補正が過剰に作用した可能性がある。

## 結果

| データ | 方式 | Hit@1 | Hit@10 | Recall@100 | MRR@10 | nDCG@10 | MAP@100 |
|---|---|---:|---:|---:|---:|---:|---:|
| Books dev, 1,528 groups | 標準BM25 | 0.1852 | 0.3704 | 0.6086 | 0.2382 | 0.2695 | 0.2465 |
| Books dev | BM25L δ=0.5 | 0.1584 | 0.3573 | 0.5982 | 0.2140 | 0.2477 | 0.2224 |
| Movies dev, fixed 1,500 groups | 標準BM25 | 0.1113 | 0.2433 | 0.4187 | 0.1496 | 0.1718 | 0.1557 |
| Movies dev | BM25L δ=0.5 | 0.0713 | 0.1713 | 0.3553 | 0.1008 | 0.1175 | 0.1072 |

## 実施条件と限界

- 同一の保存済み形態素トークン、query parser、positive-smoothed IDF、k1=1.2、b=0.75、候補集合、ラベルを使用。変更点はTF正規化式のみ。
- Booksは1,528 target groupすべてをSHA選択。Moviesは計算量を理由に、結果を確認する前に計画を改訂し、固定SHA順先頭1,500 groupを使用した。詳細は `BM25L-MOVIES-SAMPLE-AMENDMENT-2026-10-23-ja.md`。
- Movies developmentは過去に探索済みであり、独立confirmatory holdoutではない。
- ranking p50/p95はBooksで標準1.27/2.67ms、BM25L 1.08/2.17ms。Movies固定サンプルでは標準16.17/28.11ms、BM25L 15.53/28.68ms。プロセス内の連続計時で、速度差の独立評価ではない。RSS/heapはプロセス終了時の全体値。

## 成果物

- 計画: `quality/e2e/docs/BM25L-BOOKS-MOVIES-PLAN-2026-10-23-ja.md`
- Moviesサンプル計画変更: `quality/e2e/docs/BM25L-MOVIES-SAMPLE-AMENDMENT-2026-10-23-ja.md`
- Books詳細結果: `quality/e2e/artifacts/books-dev-bm25l-delta05-20261023.json`
- Movies詳細結果: `quality/e2e/artifacts/movies-dev-bm25l-delta05-fixed1500-20261023.json`
- 実行器: `scripts/bench/benchmark_tomt_bm25l.ts`
