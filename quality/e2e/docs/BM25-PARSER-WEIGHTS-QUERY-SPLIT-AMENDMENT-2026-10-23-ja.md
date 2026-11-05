# QueryAnalysis重み付きBM25: 評価データ計画の変更

## 変更理由

当初計画のCQADupStack公式ZIPを取得しようとしたところ、配布元は4.97 GiBを返し、最初の約24秒の転送は約1 MiBだったため完了見込みは30時間超となった。1 MiBの部分ファイルは検証に使わず削除した。Webis-Touche2020もダウンロード・評価していない。

## 代替する固定評価

開発結果を見てから方式・閾値を変えず、ローカルに既にあるBEIRの別クエリ分割で固定候補を一度だけ測る。

- FiQA `dev` qrels: 500 query IDs、正例連結クラスター500。FiQA testとquery ID重複0。
- SciFact `train` qrels: 809 query IDs、正例連結クラスター490。SciFact testとquery ID重複0。
- 両者ともfull corpusとKuromoji morphology BM25条件を固定して比較。
- これらは**未使用クエリ分割**だが、同じ各データセットのcorpusは以前の別方式比較で使われた。よって新しい独立コーパス評価とは呼ばず、「fresh-query-split confirmation」として限定報告する。
- 主指標nDCG@10、補助MRR@10・Hit@10・Recall@100・MAP@100。固定QueryAnalysis重みで候補BM25を比較。
- 採用条件は事前計画どおり、両splitでnDCG@10差のcluster-bootstrap 95%区間下限>0、MRRが明確に悪化せず、Hit@10/Recall@100が大きく低下しないこと。
- 結果を見てパーサー、重み、qrels、対象クエリを変更しない。

この変更は評価資源の制約によるもので、元計画のCQADupStack/Touche評価は未実施として残す。
