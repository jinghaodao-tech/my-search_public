<img width="956" height="486" alt="スクリーンショット 2026-06-19 180008" src="https://github.com/user-attachments/assets/04ac2908-02ff-4252-a1bb-090625f31e98" />
<img width="956" height="491" alt="スクリーンショット 2026-06-19 175828" src="https://github.com/user-attachments/assets/94ef29a1-2dd1-4e26-b48a-77a75c0a9e57" />

# カード索引システム — README

# カード索引システム

情報収集した記事・メモ・CSVデータをカード化し、検索・AI要約・タグ管理・カード間リンク・KJ法ボードで整理できる個人用ナレッジ管理ツール

## 作った理由

調べた情報やメモが増えると、後から探せなくなったり、関連する情報を結び付けにくくなる問題があった  
そこで、検索・要約・分類・関連付けを一つの画面で扱えるツールとして開発

## 最近の改善(20260619)

- JSON保存からSQLite保存へ移行
- 複数カード選択に対応
- 一括アーカイブ・一括削除
- アーカイブ一覧・復元機能

## 主な機能

- カード作成・編集・削除
- CSV / JSON 取り込み
- BM25によるキーワード検索
- Anthropic APIによるAI要約
- タグ管理
- Zettelkasten形式の双方向リンク
- グルーピングボードによる情報整理

## 技術スタック

- TypeScript
- Node.js
- Express
- Anthropic API
- BM25検索
- HTML/CSS/JavaScript

## 工夫した点

- BM25による関連度検索
- CSV/JSONの自動判定
- 双方向リンクによる知識ネットワーク
- AI要約の永続保存
  
**セットアップ(初回のみ)**

1. Node.js 18以上 をインストール（https://nodejs.org/）
2. `.env` ファイルを編集して APIキーを設定：
   ```
   ANTHROPIC_API_KEY
   ```
3. `start.bat` をダブルクリック → ブラウザが自動で開く

## 使い方
<details>
### 基本操作
| 操作 | 方法 |
|------|------|
| メモ新規作成 | 右上「＋ メモ作成」ボタン、または Ctrl+N |
| カード詳細表示 | カードをクリック → 右パネルに表示 |
| カード編集 | カードの ✏️ ボタン、または詳細パネルの ✏️ |
| カード削除 | 編集モーダルの「削除」ボタン |
| モーダルを閉じる | Esc キー |

---

### CSV / JSON からのカード作成

1. 右上「**📂 データ取り込み**」をクリック
2. モーダル上部タブで **CSV** または **JSON** を選択
3. ファイルをドラッグ＆ドロップ（またはクリックして選択）
4. 「取り込む」ボタン → カードが自動生成される

**CSVのフォーマット**（1行目はヘッダー必須、UTF-8推奨）：
```csv
title,body,url,tags
記事タイトル,本文テキスト,https://example.com,AI 機械学習
```

| 列名 | 別名も対応 | 必須 |
|------|----------|------|
| title | タイトル / name / headline | ✓ |
| body | content / description / text / 本文 | |
| url | link / リンク | |
| tags | tag / タグ / keywords（カンマ or スペース区切り） | |

**JSONの対応フォーマット**（自動判定）：

```json
// ① 配列形式
[{"title": "記事名", "body": "本文", "url": "https://...", "tags": ["AI"]}]

// ② ラッパー形式
{"cards": [...]}  {"articles": [...]}  {"items": [...]}

// ③ このシステムの data/cards.json をそのまま再取り込み
// ④ collector.ts の articles.json 形式（sourceAuthority フィールドで自動識別）
// ⑤ 単一オブジェクト {"title": "...", "body": "..."}
```

> タグは配列 `["AI","ML"]` でも文字列 `"AI,ML"` でも受け付けます。
> フィールド名の大文字小文字・日英は自動判定します。

---

### AI要約

- **1件ずつ**: カードの ⚡ ボタン、または詳細パネルの「AI要約を生成」
- **一括**: 右上「⚡ 一括要約」→ 未要約カードを全てバックグラウンド処理
- 要約結果はカード本文の上にハイライト表示・永続保存される

---

### タグ管理

- 左サイドバーのタグをクリック → そのタグのカードだけ表示
- 詳細パネルからタグの追加・削除が可能
- 複数タグを組み合わせたい場合は検索欄にキーワードを入力

---

### Zettelkasten（カード間リンク）

1. カードをクリックして詳細パネルを開く
2. 「Zettelkastenリンク」欄の検索ボックスにリンク先のカード名を入力
3. 候補が表示されたらクリック → **双方向リンク**が自動で貼られる
4. 「Zettelkasten」タブ → **ネットワークグラフ**でリンクの全体像を確認
   - ノードをドラッグして位置調整可
   - ノードをクリック → カード詳細を表示

---

### KJ法ボード

1. 上部「**KJ法ボード**」タブをクリック
2. 「**＋ グループ追加**」でグループ（テーマ）を作成
3. 右端「未グループ」列のカードを**ドラッグ**してグループ列に移動
4. グループ名の ✏️ で名前変更、🗑 で削除（カードは未グループに戻る）
5. カードをクリック → カード一覧ビューに切り替わり詳細を確認できる

---

### 検索・フィルター

- **キーワード検索**: 左上の検索ボックス（タイトル・本文・要約・タグを対象）
- **種別フィルター**: サイドバーの「メモ / CSV / 記事」ボタン
- **タグフィルター**: タグをクリック（再クリックで解除）
</details>

## API エンドポイント一覧（上級者向け）
<details>
```
GET    /api/cards               カード一覧（?tag=&type=&q= でフィルタ）
POST   /api/cards               カード作成
GET    /api/cards/:id           カード取得（バックリンク付き）
PUT    /api/cards/:id           カード更新
DELETE /api/cards/:id           カード削除
POST   /api/cards/:id/summarize AI要約
POST   /api/cards/import-csv    CSV取り込み

POST   /api/cards/:id/links            Zettelkastenリンク追加
DELETE /api/cards/:id/links/:targetId  リンク削除
GET    /api/zettelkasten/graph         グラフデータ取得

GET    /api/kj/groups                KJグループ一覧（カード含む）
POST   /api/kj/groups                グループ作成
PUT    /api/kj/groups/:id            グループ更新
DELETE /api/kj/groups/:id            グループ削除
POST   /api/kj/groups/:id/cards      カードをグループへ割り当て

GET    /api/tags                タグ一覧（件数付き）
</details>

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| AI要約が動かない | `.env` の `ANTHROPIC_API_KEY` を確認 |
| ブラウザが開かない | 手動で `http://localhost:3000` を開く |
| 文字化け（CSV） | CSVファイルをUTF-8で保存し直す |
| データが消えた | `data/cards.json` を確認（自動バックアップ非対応） |
