# BM25Fタイトル重みの日本語記事コーパス固定転移

## 結論

Books developmentで事前選択されたBM25F設定（title weight=2、title b=0.3、body+tags b=0.75、k1=1.2）を、日本語技術記事メタデータのdevelopment・validationへ固定転移した。両分割で標準BM25を大きく下回り、候補は棄却する。係数の再調整はしていない。本番検索は変更しない。

## 条件

- 2,484文書、development 400問、validation 400問。各分割のクエリ・正解はソースJSONLを変更せず使用。
- クエリ語は既存の標準BM25結果に保存されたparserTermsを使い、既存アプリAPI比較と同じ抽出語に固定。
- BM25Fはタイトルと本文+タグを別々にKuromoji形態素分割。IDFは保存済み形態素トークンによる標準BM25と共有。
- 独立に再実装した標準BM25のTop10は、development 400/400、validation 400/400で既存標準評価と完全一致。候補差を比較する前提を満たした。
- 正解共有クラスタは各400。20,000回paired cluster bootstrap、候補差（BM25F − 標準）のpercentile 95%区間。
- クエリは記事タイトル/タグから自己派生したデータであり、自然な利用者検索ではない。

## 結果

| 分割 | 指標 | 標準BM25 | BM25F | 差 | 95% cluster bootstrap CI |
|---|---|---:|---:|---:|---:|
| development | Hit@1 | 0.7100 | 0.6725 | −0.0375 | [−0.0650, −0.0125] |
| development | Hit@10 | 0.8800 | 0.7700 | −0.1100 | [−0.1450, −0.0775] |
| development | MRR@10 | 0.7648 | 0.7036 | −0.0612 | [−0.0849, −0.0386] |
| development | nDCG@10 | 0.7925 | 0.7194 | −0.0731 | [−0.0976, −0.0500] |
| development | Recall@100 | 0.9725 | 0.8350 | −0.1375 | [−0.1725, −0.1025] |
| validation | Hit@1 | 0.6950 | 0.6625 | −0.0325 | [−0.0600, −0.0075] |
| validation | Hit@10 | 0.8725 | 0.7375 | −0.1350 | [−0.1700, −0.1025] |
| validation | MRR@10 | 0.7491 | 0.6904 | −0.0587 | [−0.0824, −0.0362] |
| validation | nDCG@10 | 0.7786 | 0.7021 | −0.0766 | [−0.1011, −0.0534] |
| validation | Recall@100 | 0.9675 | 0.8425 | −0.1250 | [−0.1600, −0.0925] |

ランキングp50/p95は同一プロセス内の全文書スコア計算+ソートで、development標準1.45/3.15ms・BM25F 1.82/3.68ms、validation標準1.40/3.18ms・BM25F 1.79/4.16ms。フィールドtoken準備は除外。BM25Fは精度と処理時間の双方で標準より不利だった。

## 解釈

タイトル語を強める仮説は、タイトル由来の検索語を含むこのコーパスでも支持されなかった。BM25Fはこれまでの固定転移でも安定優位を示していない。標準BM25に対抗する方式として採用しない。

## 再現

```powershell
npm.cmd run typecheck
npx.cmd tsx scripts/bench/benchmark_article_bm25f_transfer.ts local_article_corpus/benchmark/search-eval-20261021.sqlite local_article_corpus/api_dataset local_article_corpus/benchmark/development-standard-bm25.json quality/e2e/artifacts/article-bm25f-transfer/development.json
npx.cmd tsx scripts/bench/benchmark_article_bm25f_transfer.ts local_article_corpus/benchmark/search-eval-20261021.sqlite local_article_corpus/api_dataset local_article_corpus/benchmark/validation-standard-bm25.json quality/e2e/artifacts/article-bm25f-transfer/validation.json
```

入力JSON・DB・クエリ別Top10・bootstrap値はartifactに保存。評価用DBは読み取り専用で開き、既存カード/記事DBには書き込まない。
