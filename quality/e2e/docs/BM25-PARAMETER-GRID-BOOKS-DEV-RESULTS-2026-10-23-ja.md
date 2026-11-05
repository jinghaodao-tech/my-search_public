# BM25 k1/b グリッド結果（Books 開発分割）

## 判定

**候補は不採用。** 12通りの固定グリッドで選ばれた `k1=1.2, b=1.0` は、Books開発分割の主要指標 nDCG@10 で既定値を超えたものの、差は +0.00192 で、事前基準の +0.005 に届かなかった。target-group cluster bootstrap 95%区間も `[-0.00148, +0.00541]` と0をまたいだ。本番ランキングは変更していない。

## 条件

- データ: Reddit-TOMT Books development、1,910文書、固定SHA選択の1,528クエリ / 1,528 target groups。
- DB: `quality/e2e/.runtime-tmp/phase2-books/benchmark.db` を読み取り専用で使用。文書IDと正解ラベルIDは `mapping.json` で照合・復元した。
- 既存の形態素トークン、クエリ解析、正解ラベル、候補集合を共通化し、変更したのは `k1` / `b` のみ。
- positive-smoothed IDF、`k1 ∈ {0.8,1.2,1.6}`、`b ∈ {0.25,0.5,0.75,1.0}`。選択は開発データの平均nDCG@10、同値ならMRR@10、次いで既定値への近さ。
- 初回実行はDB内のseed IDと正解IDの名前空間を一致させず、全指標0となったため無効と判定して破棄。mapping照合を追加して再実行した。修正版の既定BM25指標は、同じクエリ抽出を使った既存のBooks開発結果と一致した。

## 既定値との比較

| 指標 | 既定 `1.2/0.75` | 選択 `1.2/1.0` | 差 | target-group bootstrap 95% CI |
|---|---:|---:|---:|---:|
| Hit@1 | 0.18521 | 0.18652 | +0.00131 | [-0.00393, +0.00654] |
| Hit@10 | 0.37042 | 0.37435 | +0.00393 | [-0.00262, +0.01047] |
| Recall@100 | 0.60864 | 0.61387 | +0.00524 | [+0.00065, +0.01047] |
| MRR@10 | 0.23817 | 0.23954 | +0.00137 | [-0.00214, +0.00499] |
| nDCG@10 | 0.26949 | 0.27140 | +0.00192 | [-0.00148, +0.00541] |
| MAP@100 | 0.24654 | 0.24780 | +0.00126 | [-0.00210, +0.00476] |

既定値の ranking p50/p95 は 1.186/2.540 ms、選択候補は 1.181/2.413 ms。実行プロセスの測定時RSSは約465 MiB、heapUsedは約127 MiB（グリッド全体のプロセス値であり、候補ごとの増分ではない）。

## 解釈と次の扱い

Recall@100だけはbootstrap下限が0を超えたが、主要指標nDCG@10は改善基準と区間条件を満たさない。12候補を同じ開発集合で比較した選択後の探索結果でもあるため、この数値を独立確認や一般的な優位性とはみなさない。`b=1` を本番に採用せず、必要なら別コーパス・未使用クエリで固定候補として転移確認する。

## 再現

```powershell
npm.cmd run typecheck
node_modules/.bin/tsx.cmd scripts/bench/benchmark_tomt_bm25_parameter_grid.ts quality/e2e/data/reddit_tomt/books quality/e2e/.runtime-tmp/phase2-books/benchmark.db quality/e2e/artifacts/books-dev-bm25-k1b-grid-20261023.json
```

機械可読な全12構成・クエリ別結果: `quality/e2e/artifacts/books-dev-bm25-k1b-grid-20261023.json`。
