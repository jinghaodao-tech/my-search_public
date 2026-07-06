# APIノート

このドキュメントは、My Search App の主要なローカルAPIを日本語でまとめたものです。詳細なOpenAPI定義ではなく、利用時に必要な要点を軽く確認するための資料です。

## Health

### `GET /healthz`

ExpressアプリがSQLiteへ接続できるかを確認します。

## Cards

### `GET /api/cards`

カード一覧を取得します。`limit` / `offset` を指定しない場合は、後方互換のため従来通りカード配列を返します。

クエリパラメータ:

- `archived`: `true` または `false`
- `tag`: `card_tags` を使ったタグ絞り込み
- `type`: `memo`, `article`, `csv`
- `q`: title / body / summary / tag を対象にした簡易SQL `LIKE` フィルタ。BM25ランキングではありません。
- `kjGroupId`: KJグループ絞り込み
- `limit`: ページング形式を有効化。デフォルト20、最大100
- `offset`: 0始まりの取得開始位置。デフォルト0
- `sort`: `created_at_desc` または `created_at_asc`

`limit` または `offset` がある場合のレスポンス:

```json
{
  "items": [],
  "total": 123,
  "limit": 20,
  "offset": 0
}
```

BM25ランキング検索は、既存の `POST /api/run` と検索パイプライン側で扱います。

### `POST /api/cards`

カードを作成します。リクエストボディはZodで検証されます。

### `PUT /api/cards/:id`

カードを更新します。

### `DELETE /api/cards/:id`

カードを削除し、他カードからのリンク参照も整理します。

## Import / Export

- `POST /api/cards/import-csv`: CSV文字列からカードを取り込みます。
- `POST /api/cards/import-json`: JSON文字列からカードを取り込みます。
- `GET /api/cards/:id/export-md`: カード1枚をMarkdownとしてエクスポートします。
- `POST /api/cards/export-md-bulk`: 複数カードをMarkdown zipとしてエクスポートします。

## Search

### `POST /api/run`

BM25スコアリングパイプラインを実行します。`GET /api/cards?q=...` は一覧用の簡易フィルタであり、このBM25検索とは役割が異なります。
