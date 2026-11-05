# Movies生テキストFTS5固定確認・サンプル2

## 目的

offset 3502/4002の群分離標本を合算した結果、生テキストFTS5単独順位は標準BM25よりMRR@10差+0.0040、group bootstrap 95%区間の下端は+0.000005だった。この小さな改善方向がさらに新しい群でも再現するかを一度確認する。データソース自体は同じMovies development分割であり、独立コーパス証明ではない。

## 固定プロトコル

- 標本: `SHA-256(group_id)` 順offset 4502から1000群、各群1クエリを `SHA-256(group_id + NUL + query_id)` 順で選ぶ。
- 標準比較は `k1=1.2,b=0.75` の保存形態素トークンBM25。
- 候補は `cards_fts` 生テキストFTS5既定BM25単独順位。係数調整・融合・結果後の標本選択なし。
- 主指標MRR@10、補助Hit@10/Hit@1/nDCG@10。target group対応bootstrap 20,000回。
- コーパス・コード・DBはいずれも同じ。SQLiteはread-only。
