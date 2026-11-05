# PL2と標準BM25の転移比較

## 結論

公式Xapian PL2実装の式を用い、標準BM25と同じKuromoji形態素トークン、クエリ解析、候補集合で比較した。`c=1`を事前固定し、パラメータ調整は行っていない。Quora dev、NFCorpus devの両方でHit@10とnDCG@10がBM25より低くなり、PL2を候補から棄却する。

PL2はPoissonモデル、Laplace after-effect、Normalization 2からなるDFRのランキング方式であり、BM25とは別の確立済みモデルである。式はXapianの公式ソースコードとPL2 API説明を参照した: [PL2 implementation](https://xapian.org/docs/sourcedoc/html/pl2weight_8cc_source.html), [PL2 API](https://xapian.org/docs/apidoc/html/classXapian_1_1PL2Weight.html)。

## 評価条件

- 開発/転移診断であり、独立holdout・最終性能認定ではない。
- 全方式で同じクエリ・形態素解析結果・term postings・全候補文書を使用。評価正解や閾値は変更していない。
- PL2はXapianの実装式に従い、`c=1`、ユニーク化済みクエリ語のquery frequency=1。`tf'=tf*log2(1+c*avgdl/doclen)`、term contributionは `P/(tf'+1)`（`P<=0`は0）とした。
- Quoraは読み取り専用の既存SQLite索引を用い、522,931文書、5,000 devクエリ、qrel共有クラスタ5,000。
- NFCorpusは形態素トークンを新規に準備し、3,633文書、324 devクエリ。ただしqrel共有クラスタは10件のみで、統計的な精度は限定される。

## 結果

| データセット/方式 | Hit@10 | nDCG@10 | MRR@10 | MAP@100 | Recall@100 | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Quora BM25 | 0.8488 | 0.6920 | 0.6832 | 0.6499 | 0.9324 | 15.51 | 89.58 |
| Quora PL2 | 0.8462 | 0.6886 | 0.6796 | 0.6463 | 0.9311 | 16.42 | 91.91 |
| NFCorpus BM25 | 0.6173 | 0.2692 | 0.4600 | 0.1020 | 0.1983 | 0.085 | 1.010 |
| NFCorpus PL2 | 0.6111 | 0.2613 | 0.4500 | 0.0992 | 0.1979 | 0.080 | 0.889 |

| 比較差 PL2 - BM25 | Hit@10 | 95% cluster bootstrap CI | nDCG@10 | 95% cluster bootstrap CI |
|---|---:|---:|---:|---:|
| Quora | -0.0026 | [-0.0046, -0.0006] | -0.0034 | [-0.0046, -0.0023] |
| NFCorpus | -0.0062 | [-0.0063, 0] | -0.0079 | [-0.0080, 0] |

Quoraのクエリ単位ではHit@10がPL2 6勝/19敗/4,975同点、nDCG@10が73勝/195敗/4,732同点。Top10は2,391件で変化した。NFCorpusではHit@10が2勝/4敗/318同点、nDCG@10が32勝/62敗/230同点。Top10は199件で変化した。

## 速度・資源

Quora p50/p95はBM25 15.51/89.58ms、PL2 16.42/91.91msで、PL2は僅かに遅かった。NFCorpusではPL2が小さく速く見えるが、クエリ数・クラスタが少なく、タイミング値は実行環境依存である。NFCorpusの形態素索引準備は約138.7秒、評価プロセス全体のピークRSSは約630MB、heapUsedは約342MB。これはPL2単独の増分値ではない。

## 固定RRFの追試

PL2単独が異なる順位を返すことから、標準BM25とPL2を等重みRRF (`k=60`) で統合した。`k=60`はCormack et al.のSIGIR 2009論文にある固定値で、今回のデータでは調整していない: [原著論文PDF](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)。

| データセット/方式 | Hit@10 | nDCG@10 | MRR@10 | MAP@100 | Recall@100 | p50 ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Quora BM25 | 0.8488 | 0.6920 | 0.6832 | 0.6499 | 0.9324 | 16.08 | 89.03 |
| Quora BM25+PL2 RRF | 0.8484 | 0.6903 | 0.6812 | 0.6477 | 0.9317 | 31.12 | 185.36 |
| NFCorpus BM25 | 0.6173 | 0.2692 | 0.4600 | 0.1020 | 0.1983 | 0.094 | 1.090 |
| NFCorpus BM25+PL2 RRF | 0.6173 | 0.2662 | 0.4538 | 0.1003 | 0.1982 | 0.242 | 3.188 |

QuoraのRRF-BM25差はHit@10 -0.0004（95% CI `[-0.0014, 0.0006]`）、nDCG@10 -0.0018（CI `[-0.0026, -0.0010]`）。Hit@10は統計的に差を確認できず、nDCG@10は低下した。NFCorpusはHit@10差0、nDCG@10 -0.0030。10クラスタしかないため一般化はできないが、改善は出ていない。Quoraで計測したRRFレイテンシは標準BM25単独の約1.9〜2.1倍、NFCorpusは約2.6〜2.9倍で、追加コストを正当化する品質向上はなかった。

クエリ単位では、QuoraのRRFはHit@10で2勝/4敗/4,994同点、nDCG@10で43勝/132敗/4,825同点。NFCorpusはHit@10で1勝/1敗/322同点、nDCG@10で24勝/47敗/253同点だった。

## 成果物・検証

- PL2実験式: `scripts/bench/pl2.ts`
- BEIR in-memory比較: `scripts/bench/benchmark_beir_bm25_adaptive_tf.ts`
- 既存SQLite index比較: `scripts/bench/benchmark_beir_bm25_adaptive_tf_index.ts`
- 式・境界の単体テスト: `tests/bm25_adaptive.test.ts`
- Quora: `quality/e2e/artifacts/quora-dev-pl2-20261023.json`
- NFCorpus: `quality/e2e/artifacts/nfcorpus-dev-pl2-20261023.json`
- Quora BM25+PL2 RRF: `quality/e2e/artifacts/quora-dev-bm25-pl2-rrf-20261023.json`
- NFCorpus BM25+PL2 RRF: `quality/e2e/artifacts/nfcorpus-dev-bm25-pl2-rrf-20261023.json`

`npm.cmd run typecheck` とPL2を含む `npx.cmd vitest run tests/bm25_adaptive.test.ts --pool=threads --fileParallelism=false` は成功。製品ランキングとユーザーデータは変更していない。
