# デモ版を公開する手順（Hugging Face Spaces）

審査員などに触ってもらうための公開デモです。個人のメモを置く場所ではありません。

## なぜ Hugging Face Spaces か

- 無料の CPU Basic で 2 vCPU・メモリ 16GB が使える。
- このアプリは、日本語の形態素解析の辞書と PDF の読み込みで、起動後 700MB 程度のメモリを使う。
  Render の無料プラン（512MB）では足りない。
- 保存領域は再起動で消えるが、デモモードは起動のたびに見本データを入れ直すので問題ない。
- しばらく使われないと停止し、次のアクセスで起動する（起動に時間がかかる）。

## デモモードの中身（`DEMO_MODE=true`）

- データベースが空のときに見本データを入れる。
  - 見本の記事 3 本（デモ用に書き下ろした文章）
  - 見本の論文 PDF 1 本（表紙つき、印刷ページ 41〜44、柱あり）
  - メモと引用の入ったカード 2 枚
- 見本は `https://demo.my-search.invalid/...` という予約済みのアドレスで表し、
  外部には取りに行かず、リポジトリの `demo/` から読み込む。
- 外部フィードからの記事収集を止め、ページ取得・PDF 読み込みは 1 分 10 回、PDF は 10MB までに制限する。
- AI のキーを設定しない限り、AI 機能（要約・根拠探し）の画面は表示されない。
- 画面上部に「デモ版です」の注意書きと、見本を開くボタンを出す。

## 手順（はじめの 1 回）

1. 先に、デモモードを含む版を GitHub の main に push しておく（Space は main から取得する）。
2. https://huggingface.co にログインし、右上のメニューから **New Space** を選ぶ。
3. 入力：
   - Space name：`my-search-demo`（任意）
   - SDK：**Docker** → テンプレートは **Blank**
   - Hardware：**CPU basic（Free）**
   - 公開範囲：**Public**
4. 作成された Space の **Files** タブで、このリポジトリの `deploy/huggingface/` にある
   `Dockerfile` と `README.md` をアップロードして置き換える（Add file → Upload files）。
5. 自動でビルドが始まる。**Logs** に `server started` が出たら完了。
6. 審査員に渡す URL は `https://<ユーザー名>-my-search-demo.hf.space`（Space のページの「⋮ → Embed this Space」で確認できる直接の URL）。

main に新しいコミットを push したあと、Space の **Settings → Factory rebuild** を押すと最新版になる。

## 提出資料に書く内容（例）

- URL：`https://…hf.space`（ログイン不要）
- 「無料サーバーのため、しばらく使われていないと最初の表示に時間がかかります。」
- 「上部の見本ボタン（記事 3 本・論文 PDF）から、読む → 引用 → 出典つきコピーを試せます。PDF はダウンロードして『PDFを開く』からも試せます。」
- 「データは全員で共有され、再起動で見本の状態に戻ります。」

## 手元で同じ状態を試す

```bash
DEMO_MODE=true DB_PATH=data/demo.db npm start
```

Windows PowerShell：

```powershell
$env:DEMO_MODE="true"; $env:DB_PATH="data/demo.db"; npm start
```

見本 PDF は `python3 scripts/demo/build_sample_pdf.py`（reportlab が必要）で作り直せる。
