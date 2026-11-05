# タイトルcoverage w=0.4固定test転移計画

## 凍結候補

開発選択計画 `TITLE-COVERAGE-WEIGHT-SELECTION-PLAN-2026-10-23-ja.md` に従い、NFCorpus dev・SciFact train・FiQA devで選んだ`w=0.4`をtest転移に固定する。候補は標準BM25 k1=1.2/b=0.75の全コーパスランキング上位1,000文書を、候補集合内min-max正規化BM25 + `0.4 * titleKeywordCoverage`で再順位付けする。query parser・NFKC/lowercase Unicode word tokenizer・qrels・文書集合は各dataset内で共有する。

## 判定上の制約

BEIR test各splitは他のランキング方式を含む先行探索で既に参照済み。タイトルcoverage `w=0.2`のtest値も先行turnで観測済みである。今回の`w=0.4`はdev選択後に初めて実行するが、test全体を未使用・独立確認的標本とは呼ばない。testを見た後の係数変更やゲート変更は禁止する。BEIR転移結果からmy-search本番の日本語Kuromoji経路や自然な保存記事再発見率へ一般化しない。

## 固定データ

入力fingerprintは `TITLE-COVERAGE-CROSS-DATASET-TRANSFER-PLAN-2026-10-23-ja.md` 記載値を使用する。splitはTREC-COVID/NFCorpus/ArguAna/SciFact/FiQAそれぞれの `test.tsv` とし、全コーパスを含める。主指標はnDCG@10、併せてHit@1/10、MRR@10、Recall@100、MAP@100、関連qrel連結クラスタ、p50/p95、RSS/heapを出力する。正例qrel文書が1クラスタの場合、推測統計をNOT_EVALUABLEとする。

この実験は探索的転移評価。アプリ本番設定・ユーザーDBは変更しない。
