# Reddit-TOMT Books 全件E5検索の探索測定

実施日: 2026-10-26。現行の候補内E5再順位に対し、準備済みE5ベクトルを使った全件検索が書籍の既知項目質問で有効かを調べた。方式探索に使用済みのReddit-TOMT Books developmentから100個の対象記事グループを固定選択した探索値であり、保存記事の一般品質・最終95%判定には使わない。

## 固定条件

- 1,910冊、開発用100質問・100対象グループ。元ZIP SHA-256: `7c4585a9ca18bd26c4040c478d7099c9942ad6bf59462ff602d24d101e4daf03`。
- 1グループ1質問を、対象グループIDと質問IDのSHA-256順で選択。クエリ・qrelsの成績を見て選んでいない。選択指紋: `bda0bb1b5e814e8b9a150663f0954d41e3e0efce39af7035a25673a111a2f6a6`。
- オフライン `Xenova/multilingual-e5-small` q8、384次元、`query:` / `passage:` prefix、mean pooling、L2正規化。書籍のタイトルと取得可能な本文を全件事前にベクトル化し、各質問で全1,910ベクトルをexact cosine scanした。
- 検索時間は質問ベクトル生成と全件走査を含み、文書ベクトル準備時間は分離した。API HTTP処理ではなく、検索器単体の診断である。
- クエリ本文・正解ID・記事本文は集計記録へ含めず、Git除外領域 `quality/e2e/local/reddit-tomt/books/` に保存した。
- 同じ100問を使ったアプリBM25/FTS5/E5-RRF各値は、既存API比較記録から再集計したもの（`dedupThreshold=1`）。全1,842問の2026-10-26 API測定は `dedupThreshold=0.8` でBM25経路にフォールバックしており、そちらの22.20%とは設定・分割が違うため直接比較しない。

## 結果

| 方式 | Hit@10 | 対象グループbootstrap 95% CI | p50 / p95 |
|---|---:|---:|---:|
| 現行アプリBM25（既存100問API記録） | 47/100 (47%) | 37–57% | 記録参照 |
| FTS5形態素 | 44/100 (44%) | 34–54% | 記録参照 |
| FTS5候補内E5-RRF | 51/100 (51%) | 41–61% | 記録参照 |
| 全件E5 exact cosine | 40/100 (40%) | 31–49% | 41.7 / 130.6ms |
| FTS5形態素Top50 + 全件E5 Top100、等重みRRF | 52/100 (52%) | 42–62% | 再順位後の新API実測なし |

全件E5の文書ベクトル準備は43.3秒。等重みRRFはこの100問上での事後比較であり、同じデータへの適合を含む。クエリの正解グループを単位とした10,000回percentile bootstrap。エラーは全方式0件。全件E5単独はFTS5形態素より4問低く、融合の8問増は探索的であり、独立改善の証拠ではない。いずれもHit@10 95%に届かない。

再現コマンド:

```powershell
npx.cmd tsx scripts/bench/benchmark_tomt_books_full_e5.ts `
  quality/e2e/data/reddit_tomt/books `
  quality/e2e/local/reddit-tomt/books/full-e5-100-20261026-v2.json 100

node scripts/bench/analyze_tomt_books_full_e5_fusion.mjs `
  quality/e2e/local/reddit-tomt/books/full-e5-100-20261026-v2.json `
  artifacts/tomt-books-e5-dev-100-20261025-v2.json `
  quality/e2e/local/reddit-tomt/books/full-e5-fusion-100-20261026.json
```

出力JSONには集計値と検索順位の文書IDのみが入り、検索文・本文は含まれない。既に方式探索に使ったBooks開発セットなので、将来同じスコアを最終評価として再利用しない。
