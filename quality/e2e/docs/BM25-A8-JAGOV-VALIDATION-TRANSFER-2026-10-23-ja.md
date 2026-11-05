# A8混合BM25のJAGOV validation転移評価

## 結論

開発分割で候補化したA8（形態素＋N-gram、クエリ語重み・希少語重みあり、共起・網羅率なし）は、固定設定のままJAGOV validation 410問に転移しなかった。標準形態素BM25がnDCG@10でA8を0.02730上回り、正解文書を共有するクエリを単位とした95% bootstrap区間も0を含まなかった。A8は安定した優位候補として棄却する。本番検索は変更しない。

これは複数方式を探索した後の転移診断であり、全探索の多重性を調整した確認的検定や、一般利用者の検索性能認定ではない。

## データ・固定条件

- データ: JAGOV/JaGovFaqs、公式validation split 410問、全22,794文書。
- 文書コーパスはJAGOV development評価で作成済みの隔離インデックスをSQLite backupで複製。原本とdevelopment DBは読み取り専用で使用し、評価用の複製だけを使った。
- validationクエリ・正解は `local_article_corpus/japanese-human-retrieval/jagov-api/validation.jsonl` の内容をそのまま採用。クエリID・正解・分割は変更していない。
- A8と標準BM25で同じクエリ解析、形態素/N-gram保存トークン、qrels、全文書集合を使用。A8は固定済みの既存設定を使用し、validation上で係数調整なし。
- 候補集合方針は同一ではない。A8は形態素＋N-gramの候補和集合（平均4,443.3件）、標準S3は形態素一致候補のみ（平均4,107.4件）。よって本結果はランキング関数だけのアブレーションではなく、候補生成を含む固定済み検索経路の比較である。
- 標準方式は形態素BM25、k1=1.2、b=0.75。A8はk1=1.2、b=0.3、現行の固定希少語・クエリ重み、max正規化を使用し、context/coverageを無効化。
- 正例共有クラスタ: 410問中410クラスタ。20,000回のpaired cluster bootstrap、seed `20261023`、percentile 95%区間。

SHA-256:

- upstream ZIP: `097233e729323f06b54f46e0e4d4e1b7d5724176e3747fabea4413dfb4da66d0`
- JAGOV corpus: `0511e630f06d55a82bdd9fdb6ed096fbed3265d34081a2a7378710181b77d5fa`
- validation source file: `2cd1cb449e19915590a0c78324b7b370c20ceeeba5d9f8e378878482d1c63180`
- 隔離DB copy: `756448708517b28b759e14165153de80ab7b341b308fe4403d73e51e5b74201e`
- evaluation JSON: `16fb815586eeabbdfd19a003380e523a6aa3ea73faf2bb153dc6f569bba31359`

## 結果

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | p50/p95スコア+順位(ms) | 平均候補数 |
|---|---:|---:|---:|---:|---:|---:|
| 現行独自A0 | 0.5830 | 0.8976 | 0.5394 | 0.5474 | 26.66 / 106.32 | 4,443.3 |
| A8混合 | 0.5725 | 0.8951 | 0.5268 | 0.5347 | 10.99 / 51.73 | 4,443.3 |
| 標準形態素BM25 S3 | **0.5998** | **0.9000** | **0.5516** | **0.5581** | 9.00 / 49.77 | 4,107.4 |

| 対応差 | 平均差 | 95% cluster bootstrap CI | 標準が勝ち/候補が勝ち/同値 |
|---|---:|---:|---:|
| S3 − A8 nDCG@10 | +0.02730 | [+0.01018, +0.04477] | 71 / 40 / 299 |
| S3 − A0 nDCG@10 | +0.01684 | [+0.00060, +0.03343] | 64 / 41 / 305 |
| A0 − A8 nDCG@10 | +0.01046 | [+0.00334, +0.01828] | 31 / 11 / 368 |

標準BM25はA8より全ての主要品質指標で高く、p50/p95も低かった。A8はA0より速いが、検索品質を落とすため、速さだけでの置き換え候補にはしない。

プロセス累積ピークRSSは1,529.7 MiB、heapUsedは1,112 MiB。方式別増分ではなく、全文書トークンをメモリへ読み込む評価プロセス全体の高水位である。

## 再現

```powershell
npx.cmd tsx scripts/bench/evaluate_bm25_ablation.ts jagov-validation-transfer 1000 --data-dir quality/e2e/artifacts/jagov-validation-transfer --output quality/e2e/artifacts/jagov-validation-transfer/a8-vs-standard.json --variants A8-no-context-no-coverage,S3-standard-morph-k1.2-b0.75 --skip-reference --compact
npx.cmd tsx scripts/bench/paired_bm25_bootstrap.ts quality/e2e/artifacts/jagov-validation-transfer/a8-vs-standard.json quality/e2e/artifacts/jagov-validation-transfer/jagov-validation-transfer.eval.json quality/e2e/artifacts/jagov-validation-transfer/a8-vs-standard-bootstrap.json
```

生成物:

- `quality/e2e/artifacts/jagov-validation-transfer/a8-vs-standard.json`
- `quality/e2e/artifacts/jagov-validation-transfer/a8-vs-standard-bootstrap.json`
- `quality/e2e/artifacts/jagov-validation-transfer/jagov-validation-transfer.eval.json`

## 解釈

MIRACL日本語部分コーパスではA8が標準方式を上回ったが、JAGOV development・validationでは標準BM25が上回った。A8が特定データに適応している可能性があり、「日本語検索で安定優位」とは言えない。今回validationは固定転移診断であり、候補方式を多数探索した事実を踏まえ、独立最終認定とは扱わない。
