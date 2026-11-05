# BM25F タイトル重み2 固定転移結果

事前計画: `BM25F-BEIR-FIXED-TITLE2-TRANSFER-PLAN-2026-10-23-ja.md`。候補はBooks開発分割で選択したtitleWeight=2に固定し、NFCorpus/ArguAna/SciFactの公式test qrelsで再調整していない。比較は同じKuromoji形態素トークン、クエリ解析、全文書集合、qrelsを使う。

## 結果

| データセット | 文書 | クエリ | 関連文書共有クラスタ | nDCG@10 標準→BM25F | 差（クラスタbootstrap 95% CI） | Hit@10差 |
|---|---:|---:|---:|---:|---:|---:|
| NFCorpus test | 3,633 | 323 | 6 | 0.31202 → 0.31148 | -0.00054 [-0.00281, 0.00000] | 0.00000 |
| ArguAna test | 8,674 | 1,406 | 1,406 | 0.33060 → 0.33213 | +0.00153 [-0.00071, +0.00383] | +0.00498 |
| SciFact test | 5,183 | 300 | 247 | 0.67661 → 0.67904 | +0.00243 [-0.00664, +0.01256] | 0.00000 |

3データセット全てでnDCG@10の95%区間下限は0を超えず、BM25Fの固定転移による安定した優位性は確認できなかった。NFCorpusではnDCG@10の改善48クエリ・悪化43・同値232、ArguAnaでは改善75・悪化64・同値1,267。平均差は一部クエリの改善だけで説明できず、同程度の数の悪化もある。

副指標ではArguAnaのHit@10が+0.00498だが、区間は[-0.00213,+0.01209]。NFCorpusのMAP@100は+0.00163だが区間は[-0.00184,+0.00166]。副指標の一部だけを根拠に採用しない。

## レイテンシ・監査

| データセット | 標準BM25 p50/p95 (ms) | BM25F p50/p95 (ms) | RSS / heap |
|---|---:|---:|---:|
| NFCorpus | 0.195 / 2.184 | 0.126 / 1.673 | 722 MB / 315 MB |
| ArguAna | 17.208 / 27.286 | 14.858 / 24.240 | 850 MB / 462 MB |
| SciFact | 1.916 / 5.727 | 1.405 / 4.492 | 744 MB / 212 MB |

レイテンシはランキング計算のみ。トークナイズ・インデックス構築時間を含まない。RSS/heapは各単一プロセスの実行終了時値であり、方式別増分ではない。ArguAnaの公式test qrelsには公式コーパス中に存在しない正例文書が5件あることを原本ZIPでも確認した。対象IDは `test-free-speech-debate-yfsdfkhbwu-con03b`, `test-education-ufsdfkhbwu-con03b`, `test-politics-dhwem-pro06b`, `test-science-sghwbdgmo-con03b`, `test-society-asfhwapg-con04b`。正解・分母を変更せず、両方式とも検索不能な正例として公式指標に残した。したがってArguAnaの絶対スコアはこの制約込みで、相対順位差のみ同一条件の比較とする。BEIR公式の全文書検索であるが、my-search利用者の保存記事再発見性能を示すものではない。

NFCorpusのqrels関連文書共有グラフは6成分に大きく集約されるため、クラスタbootstrapの独立単位が少なく、同区間の推定は粗い。ArguAnaは1,406成分である。どちらもtest qrelsは固定候補の評価に使用済みなので、この結果自体を後続の独立確認用holdoutとして再利用しない。

## 判断

候補を棄却し、本番ランキングへの変更は行わない。BM25F titleWeight=2はBooks/Movies開発データでは微小な正方向だったが、固定転移先で一方は微減、他方は小幅改善かつ不確実であり、データセット間の安定性を満たさなかった。

再現コマンド:

```powershell
npx.cmd tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts data/ir_benchmark/work/beir-nfcorpus-extracted/nfcorpus quality/e2e/artifacts/nfcorpus-bm25f-title2-transfer-20261023.json
npx.cmd tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts data/ir_benchmark/work/beir-arguana-extracted/arguana quality/e2e/artifacts/arguana-bm25-k1b1-bm25f-joint-transfer-audited-20261023.json
npx.cmd tsx scripts/bench/benchmark_beir_bm25f_title_transfer.ts data/ir_benchmark/work/beir-scifact-check/scifact quality/e2e/artifacts/scifact-bm25-k1b1-bm25f-joint-transfer-20261023.json
```
