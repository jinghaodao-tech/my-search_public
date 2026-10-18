# 公開デモ（URL）について

審査用には、手元で起動する手順（[docs/trial.md](trial.md)）を用意しています。URL で公開する場合のメモを残します。

- メモリ（2026-10-18 実測、デモモード、検索と PDF 読み込みを数回実行した後の常駐メモリ）

  | 起動のしかた | 常駐メモリ |
  |---|---|
  | `npm start`（npm → tsx → node の 3 プロセス） | 約 920MB |
  | `npm run build` のあと `node dist/server.js` | 約 490MB |
  | 上に加えて `TOKENIZER=segmenter` | 約 260MB（実データのコピーでは約 200MB） |

  - 大きいのは日本語の形態素解析（kuromoji）の辞書（約 250〜300MB）と、tsx で動かすときの変換とソースマップ（約 250MB）。
  - `TOKENIZER=segmenter` は Node に入っている単語分割（Intl.Segmenter）を使う。辞書を読まないのでメモリをほとんど使わず、索引作りも約 40 倍速い。
    実データのコピー（292 件）で「タイトルや本文の一部から元の記事を探す」テストをすると、平均順位の指標（MRR）が約 5% 下がる（タイトル 0.212→0.202、本文 0.459→0.425）。
  - 使う分割方法を変えると、次の起動で保存済みの検索用トークンを一度だけ作り直す。
  - 個人で使うとき（手元の PC）は今までどおり kuromoji、512MB の無料サーバーで公開するデモは segmenter、という使い分けを想定している。
- Render：リポジトリの `render.yaml` を使う（Render の New → Blueprint でこのリポジトリを選ぶと、Docker・無料プラン・環境変数・ヘルスチェック `/healthz` がそのまま設定される）。
- Render の無料プラン（512MB）は、`node dist/server.js` と `TOKENIZER=segmenter` なら収まる見込み（大きな PDF の読み込み時に増えるので、デモでは `READER_PDF_MAX_MB` を小さめにする）。
- Hugging Face Spaces は 2026 年 7 月ごろから、Docker の Space を無料の CPU basic で動かすのに PRO（月 9 ドル）が必要になった。
- 検索の前準備（言い換え・要約・翻訳）に使う AI は利用者のブラウザ（Chrome 内蔵）で動くので、サーバーのメモリは使わない。
- 公開する場合も `DEMO_MODE=true` で起動すれば、見本データの投入・収集の停止・読み込み回数の制限・注意書きの表示が有効になる。
  （環境変数：`DEMO_MODE=true`、`HOST=0.0.0.0`、`PORT`、`DB_PATH`、`READER_PDF_MAX_MB=10`、`READER_RATE_LIMIT=10`）
- 候補：Google Cloud Run（無料枠あり、カード登録が必要）、Hugging Face PRO（月 9 ドル）、自分の PC を一時的に公開する方法。
