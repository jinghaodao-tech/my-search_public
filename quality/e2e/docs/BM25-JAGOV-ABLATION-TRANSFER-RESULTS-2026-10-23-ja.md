# JAGOV日本語FAQでのBM25方式転移診断

## 結論

JAGOV公式FAQの**開発分割614問**で、標準形態素BM25（k1=1.2, b=0.75）が、現行独自方式とA8混合方式の両方をnDCG@10で上回った。これは過去のMIRACL日本語部分コーパスでA8が標準BM25を上回った結果と逆方向であり、**日本語に限定してもA8の優位はコーパス間で安定しない**。方式の採否を決める独立holdout評価ではなく、開発分割による転移診断である。

本番ランキングとユーザーDBは変更していない。

## データと手順

- 出典: JAGOV/JaGovFaqs、CC-BY-4.0。`provenance.json`記載の原本SHA-256を保持。
- 全22,794文書を検索対象にし、開発分割614問をすべて評価。614問は614個のgroup、614個の異なる正解文書を持つ。正解や分割は変更していない。
- このFAQ質問はデータセットが作成した質問であり、my-searchの利用者検索ログではない。
- A0は現行独自方式、A8は形態素/N-gram混合・クエリ重み・希少語重みあり、共起・網羅率なし。S3は形態素のみの標準BM25（k1=1.2,b=0.75）。クエリ解析は3方式共通。
- A8とA0は形態素/N-gram候補の共有和集合、S3は形態素一致候補のみ。よってこれは完全に候補集合を固定したランキング単独比較ではなく、トークン方式を含む検索経路の比較。S3の候補集合は平均4,135.7件、A8/A0は4,431.1件で、標準方式は狭い候補集合でも優位だった。
- 元のJAGOV SQLiteは読み取り専用。アプリ本番DBではなく、`quality/e2e/artifacts/jagov-development/`の隔離DBを使用。
- 全記事に同一日付が割り当てられるため、時間減衰の効果はこの評価では識別できない。

## 結果

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | p50/p95スコア+順位(ms) | 平均候補数 |
|---|---:|---:|---:|---:|---:|---:|
| A0 現行独自 | 0.5527 | 0.8534 | 0.5009 | 0.5067 | 32.93 / 123.10 | 4,431.1 |
| A8 混合・共起/網羅なし | 0.5404 | 0.8485 | 0.4870 | 0.4930 | 13.76 / 59.99 | 4,431.1 |
| S3 標準形態素BM25 | **0.5695** | **0.8746** | **0.5193** | **0.5257** | **11.34 / 54.66** | 4,135.7 |

| 対応差 | nDCG@10差 | 95% paired cluster bootstrap CI | 改善/悪化/同値クエリ |
|---|---:|---:|---:|
| S3 − A8 | +0.02910 | [+0.01495, +0.04355] | 109 / 66 / 439 |
| S3 − A0 | +0.01683 | [+0.00311, +0.03070] | 97 / 77 / 440 |
| A0 − A8 | +0.01228 | [+0.00513, +0.01973] | 58 / 23 / 533 |

bootstrapは正例文書を共有するクエリを同一連結成分として再標本化する。今回のJAGOV開発分割では全正解文書がユニークなので614クエリが614成分となった。20,000反復、固定seed `20261023`、percentile 95%区間。これは探索済み開発データ上の推定であり、確認的な有意差認定ではない。

## 性能・制約

- 共通準備（クエリ解析と転置posting構築）: 2,262 ms。
- スコア+順位のp50/p95はランキング段階のみ。DB読み込み・共通前処理・HTTP応答は含まない。
- 単一Nodeプロセスの累積ピークRSS 1,386.8 MiB、heapUsed 954.0 MiB。方式別の増分メモリではない。小型PCに十分軽いとは言えず、全文トークンをNode側へロードする評価実装自体に改善余地がある。
- 評価記事のタイトルが空の場合、共通importerは表示用タイトルを本文先頭から生成する。ただしトークン列は空タイトル+本文から作成し、全方式で同一の保存済みトークンを使った。
- 公式FAQの対応関係を使った検索であり、個人の保存記事を思い出して再発見する利用者性能には一般化しない。

## 再現コマンド

```powershell
npx.cmd tsx scripts/bench/import_benchmark.ts --jagov local_article_corpus/japanese-human-retrieval/jagov-api --name jagov-dev --split development --out quality/e2e/artifacts/jagov-development
npx.cmd tsx scripts/bench/evaluate_bm25_ablation.ts jagov-dev 614 --data-dir quality/e2e/artifacts/jagov-development --output quality/e2e/artifacts/jagov-a8-transfer.json --variants A8-no-context-no-coverage,S3-standard-morph-k1.2-b0.75 --skip-reference --compact
npx.cmd tsx scripts/bench/paired_bm25_bootstrap.ts quality/e2e/artifacts/jagov-a8-transfer.json quality/e2e/artifacts/jagov-development/jagov-dev.eval.json quality/e2e/artifacts/jagov-a8-transfer-bootstrap.json
```

`import_benchmark.ts`は既存の同名DB/evalファイルを上書きせずエラーにする。再実行時は別の未使用出力ディレクトリ名を指定する。

## 判断

JAGOVでは標準BM25が優位だったが、別コーパスの開発分割であり、以前のMIRACLの結果も探索に使われている。したがって「標準BM25が普遍的に優れる」も「A8が日本語で優れる」も証明しない。現在言えるのは、**A8のMIRACL改善は少なくともJAGOV開発分割にそのまま転移しなかった**こと。標準方式を本番へ切り替えず、独立した新規コーパス/クエリで再確認する。
