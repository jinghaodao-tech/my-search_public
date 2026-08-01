# My Search App

My Search Appは、カード型の知識をSQLiteへ保存し、BM25でローカル検索するナレッジ管理アプリです。収集候補、Review、カード保存、整理、検索、エクスポートの流れを分離して管理します。

## 主な機能

- カード、タグ、リンク、KJグループのCRUD
- RSS・arXiv・GitHubなどの収集候補と保存状態の管理
- BM25検索と保存済みカードのSQLite検索
- 日本語・英語を含む決定的な検索品質評価
- Vitest、Supertest、Playwright、GitHub Actionsによる検証

## 検索品質評価

評価datasetは `v4-50-docs-11-query-cases`（50文書、11ケース）です。ランキングのみの評価と、raw queryからQuery Parserを通るend-to-end評価を別々に保存します。

- `artifacts/ranking-engine-quality.json`
- `artifacts/end-to-end-query-quality.json`
- `artifacts/search-quality.json`

評価ケースには、明確な正例、日本語、近い負例、タイトルと本文の競合、長文、時間減衰の罠、Parserの曖昧性を含みます。

## 開発

```powershell
npm ci
npm run evaluate:search
npm run benchmark
npm run benchmark:http
npm run verify
```

詳細は [README.md](README.md)、[docs/search-quality.md](docs/search-quality.md)、[docs/benchmark.md](docs/benchmark.md) を参照してください。