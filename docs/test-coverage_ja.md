# Test Coverage 日本語版

最終確認コマンド:

```bash
npm run verify
```

`verify` では以下をまとめて実行します。

- `npm run typecheck`
- `npm test`
- `npm run acceptance:test`
- `npm run test:e2e`
- `npm run benchmark`
- `npm run evaluate:search`
- `npm run check:encoding`
- `npm audit --audit-level=high`
- `docker build -t my-search-public:test .`

## 主なテスト対象

- Card CRUD
- Archive / Restore
- Bulk Archive / Bulk Delete
- Tag操作と `card_tags` 中間テーブル
- Zettelkasten links / backlinks と `card_links` 中間テーブル
- KJ groups
- CSV / JSON import
- Markdown export
- BM25 ranking
- Search quality evaluation
- API validation
- Logging / request ID / error response
- E2E user flows
- UTF-8 / 日本語文字化けチェック

## 文字化けチェック

`npm run check:encoding` で README、docs、public UI、routes/services/utils、tests を対象に、代表的な文字化けパターンや不正な制御文字を検出します。

また、日本語カード、タグ、KJグループ、Markdown export、CSV/JSON import が壊れないことをテストしています。
