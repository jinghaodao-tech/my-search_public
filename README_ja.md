# My Search App

[![CI](https://github.com/jinghaodao-tech/my-search_public/actions/workflows/ci.yml/badge.svg)](https://github.com/jinghaodao-tech/my-search_public/actions/workflows/ci.yml)

[English README](README.md)

## 概要

My Search App は、ローカルファーストの知識管理アプリです。カード型メモを中心に、BM25検索、SQLite永続化、タグ、Zettelkastenリンク、KJグループ、CSV/JSON import、Markdown export、AI要約を備えています。

このリポジトリは、単なるメモアプリではなく、検索・DB設計・API設計・テスト・CI・ベンチマークを説明できるポートフォリオとして整えています。

## Stable Portfolio Version

このリポジトリは、local-first knowledge management app としての安定版ポートフォリオです。現在の目的は、ローカル環境での知識管理、BM25検索、SQLite永続化、テスト・CI・ベンチマークを含むバックエンド品質を示すことです。

今後の改善は、現在版に必須の機能ではなく、段階的な Future Improvements として扱います。

詳細ドキュメント:

- [API例](docs/api_ja.md)
- [ログとエラー可観測性](docs/logging_ja.md)
- [E2Eテスト](docs/e2e_ja.md)
- [テストカバレッジ](docs/test-coverage_ja.md)
- [プロジェクト詳細・DB設計・運用](docs/project-details_ja.md)
- [設計判断](docs/design-decisions_ja.md)
- [ベンチマーク](docs/benchmark_ja.md)
- [検索品質評価](docs/search-quality_ja.md)
- [License](LICENSE): MIT

## デモ

https://github.com/user-attachments/assets/be5052d8-1d60-4aaa-8f6a-565dbaa1ee4d

## 特徴

- カードのタイトル・本文・要約・タグを対象にしたBM25検索
- SQLiteによるローカル永続化
- `card_tags` / `card_links` による正規化された関係管理
- 収集記事のSQLite保存、URL重複排除、トークンキャッシュ
- カードCRUD、アーカイブ/復元、一括操作、Markdown export
- Zettelkastenリンク、バックリンク、ネットワーク表示
- SQLite backed のKJグループ
- CSV/JSON import とZod validation
- Anthropic / Gemini によるAI要約、テスト用mock mode
- Pino構造化ログ、request ID、rate limit
- Vitest / Supertest / Playwright によるテスト
- Docker / Docker Compose / GitHub Actions CI

## Architecture

```mermaid
flowchart LR
  user["User / Browser"] --> ui["Static HTML/CSS/JS UI"]
  ui --> api["Express API Server"]

  api --> middleware["Middleware<br/>Helmet, CORS, rate limits, request IDs"]
  middleware --> validation["Zod Validation"]
  validation --> services["Controllers / Services"]
  services --> search["BM25 Pipeline"]
  services --> sqlite[("SQLite")]
  search --> sqlite

  sqlite --> cards["cards"]
  sqlite --> tags["card_tags"]
  sqlite --> links["card_links"]
  sqlite --> groups["kj_groups"]

  services --> ai["AI Provider Switch"]
  ai --> anthropic["Anthropic"]
  ai --> gemini["Gemini"]

  tests["Vitest / Supertest / Playwright"] --> api
  ci["GitHub Actions"] --> tests
```

詳しい設計は [docs/project-details_ja.md](docs/project-details_ja.md) を参照してください。

## Benchmark

BM25検索は、検索時に毎回トークン化する方式から、保存時に `tokens_json` と `doc_length` を事前計算してSQLiteに保存する方式へ改善しました。

| Stage | Before | After |
|---|---:|---:|
| Load cards | 2.175 ms | 7.054 ms |
| Tokenize | 4.584 s | 0.464 ms |
| Score | 4.705 s | 40.778 ms |
| Total BM25 | 9.705 s | 1.413 s |

最大の改善は、検索ごとの形態素解析をなくしたことです。残るボトルネック候補は、DBアクセス、集計、ソートです。

再現可能なベンチマークは [docs/benchmark_ja.md](docs/benchmark_ja.md) を参照してください。検索品質評価は [docs/search-quality_ja.md](docs/search-quality_ja.md) にまとめています。

## 技術スタック

| 領域 | 技術 |
|---|---|
| Backend | Node.js, TypeScript, Express |
| Database | SQLite, better-sqlite3 |
| Search | BM25, persisted token data |
| Validation / Security | Zod, Helmet, CORS, express-rate-limit |
| Testing | Vitest, Supertest, Playwright |
| DevOps | Docker, Docker Compose, GitHub Actions |
| Frontend | HTML, CSS, JavaScript |
| AI | Anthropic API, Gemini API |
