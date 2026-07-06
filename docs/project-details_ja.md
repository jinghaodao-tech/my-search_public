# Project Details 日本語版

このドキュメントは、READMEを長くしすぎないための詳細説明です。

## 背景

最初のバージョンではカードデータをJSONファイルに保存していました。実装は簡単でしたが、データが増えると全件読み書きやリレーション管理が難しくなりました。そのため、既存APIの形を維持しつつSQLiteへ移行しました。

検索にはBM25を使っています。検索時に毎回カード本文をトークン化するのではなく、保存時に `tokens_json` と `doc_length` を生成してSQLiteに保存します。これにより検索時の形態素解析コストを削減しています。

## Stable Portfolio Version

この版は、local-first knowledge management app としての安定版ポートフォリオです。今後の改善は、現在版に必須の機能ではなく、段階的なFuture Improvementsとして扱います。

## DB設計

| Table | 役割 |
|---|---|
| `cards` | カード本文、アーカイブ状態、KJグループ、BM25用トークン |
| `articles` | 収集記事、URL重複排除、BM25 token cache |
| `card_tags` | カードとタグの中間テーブル |
| `card_links` | Zettelkastenリンクとバックリンクの関係 |
| `kj_groups` | KJグループ情報 |
| `schema_migrations` | ローカルmigration管理 |

`tags_json` と `links_json` は互換用キャッシュとして残していますが、通常の読み書きは `card_tags` と `card_links` を使います。

## `loadCards()` と `getCards()` の設計

以前は全カードを読み込み、タグ・リンクも全件hydrateしてからJavaScript側でfilter/sortしていました。現在は、カード一覧取得で `archived`、`type`、`kjGroupId`、`tag`、簡易 `q`、`limit`、`offset`、`created_at` ordering をSQLite側に寄せています。

`GET /api/cards` は後方互換のため、`limit` / `offset` がない場合は従来通り配列を返します。`limit` または `offset` がある場合は、`items`、`total`、`limit`、`offset` を持つページング形式を返します。

ページング時は、取得対象カードだけタグ・リンクをhydrateします。これにより、一覧表示で不要なrelation読み込みを減らしています。

`q` はカード一覧用の簡易LIKEフィルタです。BM25ランキング検索とは役割が異なり、BM25は既存の検索パイプラインで扱います。

## 収集記事の永続化

収集記事は `data/articles.json` からSQLiteの `articles` テーブルへ移行しました。URL重複排除、source情報、publish日時、tags、`tokens_json`、`doc_length`、`content_hash` を保存します。

## 運用コマンド

```bash
npm start
npm run dev
npm run verify
npm run benchmark
npm run backup
npm run db:migrate
npm run migrate:articles
npm run migrate:kj-groups
```
