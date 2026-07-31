# テストカバレッジ

最終確認日: 2026-07-31

## 実行コマンド

```bash
npm run typecheck
npm test
npm run acceptance:test
npm run test:e2e
npm run benchmark
npm run benchmark:http
npm run evaluate:search
npm run check:encoding
npm run verify
```

## 最新結果

- `npm run typecheck`: 成功
- `npm test`: 36/36 成功
- `npm run acceptance:test`: 59/59 成功
- `npm run test:e2e`: 7/7 成功
- `npm run benchmark`: ranking-only、production-like、API、cold-start、warm-search 成功
- `npm run benchmark:http`: HTTP cold-start / warm-search 成功
- `npm run evaluate:search`: Precision@1 1.0、MRR 1.0、Recall@5 1.0、nDCG@5 1.0
- `npm run check:encoding`: 成功
- `npm audit --audit-level=high`: 脆弱性0件
- Docker build: 成功
- `npm run verify`: 成功

候補ライフサイクル、SQLite外部キー、Migration rollback、directed link、BM25一致理由、E2E主要フローも確認済みです。
