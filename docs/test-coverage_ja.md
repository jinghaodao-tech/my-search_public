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
- `npm run acceptance:test`: 62/62 成功
- `npm run test:e2e`: 9/9 成功
- `npm run benchmark`: ranking-only、production-like、API、cold-start、warm-search 成功
- `npm run benchmark:http`: HTTP cold-start / warm-search 成功
- `npm run evaluate:search`: Precision@1 1.0、MRR 1.0、Recall@5 1.0、nDCG@5 1.0
- `npm run check:encoding`: 成功
- `npm audit --audit-level=high`: 脆弱性0件
- Docker build: 成功
- `npm run verify`: 成功

候補ライフサイクル、SQLite外部キー、Migration rollback、directed link、BM25一致理由、E2E主要フローも確認済みです。

## 95点プロンプト照合で追加

- 候補保存に saved_card_id の一意関係と競合時の後始末を追加。
- POST /api/collect に決定的な portfolio-demo fixture を追加。
- BM25入力境界、ブラウザ共通APIのnon-2xx処理、旧archiveルートの廃止ヘッダーを追加。
- 検証スクリプトが3種類のJSON成果物を artifacts/ に生成。

- スキーマ検証: 必須6テーブル、foreign_key_check=0、integrity_check=ok、saved_card一意インデックスを確認。
- 候補ベンチマーク: near-duplicateはafterDedup=1、diverseはafterDedup=200。
