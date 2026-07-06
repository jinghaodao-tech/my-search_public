# E2E Tests 日本語版

Playwrightで、実際のブラウザ操作を通じて主要ユーザーフローを検証します。

## 実行方法

```bash
npm run test:e2e
```

UI付きで確認する場合:

```bash
npm run test:e2e:ui
```

## テスト用DB

E2Eでは本番用DBを汚さないよう、テスト専用のDBパスを使います。テストデータはE2E内で作成されます。

## カバーしている主なフロー

- カード作成
- BM25検索
- アーカイブ / 復元
- KJグループ作成・更新・削除
- Zettelkastenリンク / バックリンク

## CI

GitHub ActionsではChromiumをインストールし、`npm run test:e2e` を実行します。
