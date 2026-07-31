# 15分デモ手順

## 0:00-1:30 中心フロー

このデモでは、収集候補をBM25で選別し、レビュー、カード保存、整理、通常検索、Markdown出力までを確認します。

## 1:30-3:00 デモデータ

一発で起動する場合:

```bash
npm run demo
```

分けて実行する場合:

```bash
npm run seed:demo
npm start
```

デモ候補「Demo candidate: SQLite BM25 ranking」が候補一覧に表示されます。

## 3:00-5:00 BM25選別

BM25画面で候補を検索し、スコア、一致理由、公開日、sourceを確認します。

## 5:00-8:00 Reviewと保存

候補をレビュー済みに変更し、別の候補を見送ります。保存する候補を「カードに保存」し、`saved_as_card`状態を確認します。

## 8:00-11:00 整理

保存カードにタグを付け、KJグループへ割り当てます。別カードへのdirected linkを作成し、backlinkを確認します。

## 11:00-13:00 再検索

「保存済みカードを検索」で保存後のカードを検索します。これはBM25候補検索とは別のSQLite LIKE検索です。

## 13:00-14:00 Export

カード詳細からMarkdown exportを実行します。

## 14:00-15:00 設計説明

SQLite、事前計算tokens、候補保持期間、foreign key、migration、local-first、任意のAI要約を説明します。

検証コマンド:

```bash
npm run verify
npm run benchmark:http
```
