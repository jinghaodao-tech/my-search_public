# BM25 k1=1.2,b=1.0 固定転移結果

計画: `BM25-K1B1-BEIR-TRANSFER-PLAN-2026-10-23-ja.md`。候補はBooks developmentのk1/b gridから事前に固定し、BEIR側で再調整していない。比較実装では標準BM25、k1=1.2、b=.75を同じ実行内で再計算した。

## 結果

| データセット | 文書 | クエリ | qrelクラスタ | nDCG@10 標準→b=1 | 差（95% cluster bootstrap CI） | Hit@10差 | Recall@100差 |
|---|---:|---:|---:|---:|---:|---:|---:|
| NFCorpus test | 3,633 | 323 | 6 | 0.31202 → 0.30932 | -0.00270 [-0.07063, 0.00000] | -0.00310 | +0.00068 |
| ArguAna test | 8,674 | 1,406 | 1,406 | 0.33060 → 0.35726 | +0.02666 [+0.02282, +0.03061] | +0.04552 | +0.00996 |
| SciFact test | 5,183 | 300 | 247 | 0.67661 → 0.67902 | +0.00242 [-0.00494, +0.00957] | +0.00333 | +0.00333 |

ArguAnaでは大きく改善し、95%区間下限も正だった。一方NFCorpusでは平均nDCGが低下し、Hit@1も0.44892から0.43344へ落ちた。SciFactでは微増だが区間は0をまたぐ。NFCorpusは関連文書共有ネットワークが6クラスタに集約され、区間が粗く上限は0になった。ArguAnaの公式test qrelsには公式コーパス内にない正例文書が5件ある。正解を変更せず全qrelsを分母に含め、両方式に同じく検索不能として扱った。欠落IDはBM25F転移結果レポート記載の5件と同じである。3データセットで効果方向と大きさが揃わず、固定b=1を全コーパス向けの優位方式とは判断しない。

これは1つのb値を固定転移した探索的評価である。BEIR公式testはこの実行で消費済みとして扱い、別の係数選択や後続の最終確認に再利用しない。同一評価対象でBM25F固定候補も併測しているため、ここに記した個別区間は多重性調整後の採用検定ではない。

## 比較実装と速度

同一トークナイザー、パーサー、IDF、全文書候補を使った。指標は正解データを改変せず公式test qrels全件で計算した。ArguAnaには公式コーパスに存在しない正例文書が5件ある（IDはBM25F転移結果レポートに列挙）。5件は両方式に同じく検索不能で、絶対スコアの分母に残るが、方式差には同一の扱いとなる。

| データセット | 標準 p50/p95 (ms) | b=1 p50/p95 (ms) | BM25F title2 p50/p95 (ms) |
|---|---:|---:|---:|
| NFCorpus | 0.182 / 2.009 | 0.116 / 1.671 | 0.102 / 1.468 |
| ArguAna | 17.805 / 28.424 | 16.133 / 27.120 | 15.238 / 25.318 |
| SciFact | 1.916 / 5.727 | 1.528 / 5.001 | 1.405 / 4.492 |

時間はランキング処理のみ。RSS/heapは方式別増分ではなく単一ベンチマークプロセス全体の値。ArguAna実行時RSSは約1.05 GB、heapは約644 MB。実装方式間で演算のために遅くなる兆候はないが、これは独立した常駐メモリ計測ではない。

## 判断

現時点での本番導入はしない。b=1はArguAnaに有効だがNFCorpusに転移せず、標準BM25に対する**安定した優位方式**という目標を満たさない。次の実験課題は「文書長分布など、正解ラベルを見ずに取得できるコーパス統計からbを選ぶ」方式だが、開発データでルールを作り、別の未使用コーパス群で固定評価する必要がある。

再現コマンド:

```powershell
npx.cmd tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts data/ir_benchmark/work/beir-nfcorpus-extracted/nfcorpus quality/e2e/artifacts/nfcorpus-bm25-k1b1-bm25f-joint-transfer-20261023.json
npx.cmd tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts data/ir_benchmark/work/beir-arguana-extracted/arguana quality/e2e/artifacts/arguana-bm25-k1b1-bm25f-joint-transfer-audited-20261023.json
```
