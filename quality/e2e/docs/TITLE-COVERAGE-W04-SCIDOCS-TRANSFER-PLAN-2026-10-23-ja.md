# Title coverage w=0.4 SciDocs固定転移計画

## 候補と評価

開発選択済みの`w=0.4`を変更せず、BEIR SciDocs testの全25,657文書・1,000クエリで標準BM25 k1=1.2/b=0.75と比較する。標準BM25 top1000候補を、候補集合内min-max BM25 + `0.4 * titleKeywordCoverage`で再順位付けする。query parser、Unicode word tokenizer、コーパス、qrelsを両方式で共有する。

SciDocs testは以前RRF方式比較に使われているため未使用holdoutではない。タイトルcoverage w=0.4の評価前に候補・閾値は凍結する。評価後に調整しない。my-search本番Kuromoji経路や自然な保存記事再発見への一般化を主張しない。

## 入力fingerprint

- corpus SHA-256: `328BB38854179C83EE40D4F49FAE2EF7209EDE7163785193CBDCD5906B28EECC`
- queries SHA-256: `3C85B68419BD579FF52EDB58F9E7B32EB3D18BC83435EDB71DBB68AAF79531D6`
- test qrels SHA-256: `DCD3D7F77417294BB6F338537F3C28D8A5EA72B30FE6633F407FA85528767E35`

報告はHit@1/10、MRR@10、nDCG@10、Recall@100、MAP@100、qrel関連クラスタbootstrap、ranking-only p50/p95、RSS/heapを含む。索引は読み取り専用のBEIRファイルから構築し、製品DBは変更しない。
