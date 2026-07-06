# Search Quality Evaluation 日本語版

検索アプリでは速度だけでなく、検索結果の妥当性も説明できる必要があります。このプロジェクトでは、小さな固定データセットを使って検索品質を確認しています。

## 実行方法

```bash
npm run evaluate:search
```

## 評価データ

BM25 token cache、Zettelkasten backlinks、CSV/JSON import validation など、アプリの主要機能に関する固定データを使います。各クエリには期待される上位結果を定義しています。

## 指標

- Precision@1: 1位の結果が期待した関連結果かどうか
- MRR: 最初の関連結果が何位に出たか

現在の固定評価では、`meanPrecisionAt1 = 1.0`、`MRR = 1.0` を期待します。

## 限界

これは研究用途の大規模評価ではありません。目的は、明らかなランキング退行を検知し、検索品質について説明できる状態にすることです。

## 今後の比較候補

- 現在のBM25
- simple keyword matching
- SQLite FTS5
- vector search
- BM25 + vector search のハイブリッド
