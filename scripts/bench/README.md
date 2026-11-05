# 公開ベンチマークで検索を比べる（Chrome内蔵AIあり／なし）

正解（関連判定）が公開されている検索ベンチマークを**隔離したDB**に入れ、my-search の検索を次の3通りで比べます。

| モード | 中身 |
|---|---|
| app | 探す画面と同じ。文から検索語を作り（/api/search/terms）、BM25で検索 |
| app+ai-synonyms | app に、Chrome内蔵AIの類義語を足す（「AIで言い換え」と同じ足し方） |
| app+ai-queries | app に、Chrome内蔵AIが作った検索語での検索を足し、順位を融合（RRF） |

指標：nDCG@10、MRR@10、Recall@100。データの一部だけを使うので、論文の公式スコアとは比べられません。比べるのはモード間の差です。

## 1. 原本を取る

`data\ir_benchmark\download_original_datasets.py`（Git管理外）を使います。

## 2. 隔離DBへ取り込む（実利用の data/cards.db には触れません）

```powershell
# SciFact（英語、約5千件・質問300）: ZIPから直接読む
npx tsx scripts/bench/import_benchmark.ts --beir data\ir_benchmark\ir_benchmark_originals\beir\scifact.zip --name scifact
# MIRACL 日本語: 質問200件 + その正解・不正解の文書 + 他の文書で約3万件
npx tsx scripts/bench/import_benchmark.ts --miracl data\ir_benchmark\ir_benchmark_originals --name miracl-ja --queries 200 --docs 30000
# JAGOV: 公式FAQの開発分割を使う日本語コーパス転移診断
npx tsx scripts/bench/import_benchmark.ts --jagov local_article_corpus\japanese-human-retrieval\jagov-api --name jagov-dev --split development --out quality/e2e/artifacts/jagov-development
```

できるもの：`data/bench/<name>.db`（記事の情報源は `bench:<name>`）と `data/bench/<name>.eval.json`（質問と正解）。

JAGOVでは `--out` に隔離先を指定し、既存の公式データ・正解・分割を読み取り専用で使います。同名のDB/eval出力が既にある場合、importerは上書きを拒否します。JAGOV開発分割のA8対標準BM25評価とpaired cluster bootstrapの再現手順は `quality/e2e/docs/BM25-JAGOV-ABLATION-TRANSFER-RESULTS-2026-10-23-ja.md` を参照してください。

## 3. ベンチマーク用にサーバーを起動

```powershell
npm run bench -- scifact      # または miracl-ja
```

http://localhost:3100 で、そのベンチマークのDBだけを使って起動します（`/bench/` もこのときだけ開きます）。

## 4. Chrome（内蔵AIあり）で実行

http://localhost:3100 を開き、開発者ツールのコンソールで：

```js
await import('/bench/runner.js');
await runBench({ name: 'scifact', limit: 50 }); // まず50問。limit を外すと全問
benchSummary('scifact');                       // 途中経過・結果
```

進み具合はブラウザに保存されるので、再読み込みしても続きから再開します（最初からやり直すときは `reset: true`）。
