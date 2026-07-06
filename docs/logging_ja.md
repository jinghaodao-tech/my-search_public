# Logging and Error Observability 日本語版

このアプリは、ローカルファーストでありながら実務に近いバックエンド品質を示すため、構造化ログとrequest IDを導入しています。

## 方針

- PinoによるJSONログ
- request IDによるリクエスト追跡
- validation error / 404 / 500 のエラーレスポンス統一
- APIキー、Authorization header、Cookie、カード本文、AI prompt本文などの秘匿情報をログに出さない

## エラーレスポンス例

```json
{
  "error": "Invalid request",
  "requestId": "..."
}
```

## 確認方法

ローカル実行時:

```bash
npm start
```

Docker Compose利用時:

```bash
docker compose up
```

## テスト

request ID、validation error、404、500時のstack trace非公開、秘匿情報がログに出ないことをテストしています。
