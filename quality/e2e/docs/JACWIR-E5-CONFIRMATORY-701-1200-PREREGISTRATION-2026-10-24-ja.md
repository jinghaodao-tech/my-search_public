# JaCWIR確認試験: 未使用query 701–1200 事前登録

登録: 2026-10-24 JST  
状態: 601–700パイロット結果を分離したうえで、701–1200のquery本文・正解・順位結果の確認前に固定  
目的: JaCWIR内の未使用500 queryで、標準BM25に対する固定済みE5再順位付けとRRFの差を確認する。

## 試験データと分割

- 出典: 取得済み`hotchpotch/JaCWIR`公式公開データ `eval-00000-of-00001.parquet` / `collection-00000-of-00001.parquet`。
- 全distinct queryをSHA-256(query)昇順に並べた701–1200番目、500問を機械的に選ぶ。601–700パイロット、および先行して評価済みの1–600は含めない。
- 対象コーパスは513,107文書すべて。既存の読み取り専用評価索引を使う。
- 各queryに対応する元データ中のpositive判定をすべて保持する。ラベルは検索結果で変更しない。
- 601–700は探索用パイロットであり、本確認試験の主推定値・有意判定には混ぜない。

## 固定する方式

- BM25: Kuromoji形態素解析、NFKC、`k1=1.2`、`b=0.75`、全文書からexact Top-100。
- E5: `multilingual-e5-small` q8、BM25 Top-100内のみ再順位付け。
- RRF: 同じBM25 Top-100内でBM25順位とE5順位を等重み、`k=60`。
- 候補深度、モデル、tokenizer、query parsing、指標、データ分割を結果確認後に変更しない。

## 評価・判定

- 主指標: known-positive binary nDCG@10。主比較は`RRF − BM25`。
- 副指標: Hit@1、Hit@10、MRR@10、MAP@100、Recall@100、BM25 Top-100正解候補率、p50/p95 latency、Embedding容量、RSS/heap。
- positive文書を共有するquery間の依存を連結成分として保持し、20,000回paired cluster bootstrap、両側95% percentile CIを使う。
- この確認試験でRRF改善を支持する条件はnDCG@10差の95% CI下限が0を上回ること。E5単独は副次比較。
- 本試験は一度だけ実行する。未達の場合は「この試験では優位性未確認」とし、途中の有意性検定で打ち切らない。
- レイテンシにはBM25 query parsing/postings/scoring/top-100、E5 query embeddingと候補スコアリング、RRFを含める。候補Embeddingの初回作成は別計測。

## 解釈範囲

JaCWIRの既知正解検索に限る。同一の公開データ源内の未使用query splitであり、別データ源の独立再現ではない。qrelsは全513,107文書に対する網羅的関連判定ではないため、適合率や実利用者の再発見成功率に一般化しない。
