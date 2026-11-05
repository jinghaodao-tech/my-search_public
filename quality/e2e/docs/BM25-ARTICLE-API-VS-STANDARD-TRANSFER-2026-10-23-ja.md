# 日本語記事コーパスでのUI検索と標準BM25の対応比較

## 結論

2,484件の日本語技術記事メタデータで、既存のUI相当保存カード検索APIは標準BM25よりHit@10・MRR@10・nDCG@10が高かった。nDCG@10差の95%正解対象クラスタbootstrap区間は、development・validationの両方で0を上回る。これは**このコーパスとタイトル/タグ由来クエリに限定した有望な候補**であり、自然な利用者検索に対する安定優位の証明ではない。

同じ方式でもJAGOV FAQでは標準BM25が上回っているため、全ドメインを通した優位とは言えない。現行APIには既に複数の検索処理が含まれるが、個々の補正の寄与はこの比較から分離できない。本番の既定方式は変更しない。

## 比較条件

- 全2,484文書を両方式で検索し、development 400問、validation 400問を別々に集計。
- 両入力のquery ID・expected labelを照合し、`keyword_terms` と `parserTerms` が全800問で完全一致することを検査。
- App方式: UI相当の `POST /api/search/terms` → `POST /api/cards/search` 経路、当時のbuild source fingerprint `sha256:2d4a132321eec82baa34c237f09ac4c80b2071fe64a8c603dce6db16a2e9f1ee`。
- 標準方式: 保存済み形態素トークンに対する独立BM25、k1=1.2、b=0.75、アプリ独自補正なし。
- クエリ群は400個ずつで、正解対象共有を含む連結クラスタ数も各400。20,000回のpaired percentile cluster bootstrap。developmentとvalidationを混ぜていない。
- APIエラーは両分割とも0件。クエリはタイトル・タグ情報から自己派生したベンチマークであり、人間の自然検索記録ではない。

## 品質結果

値はApp方式、標準BM25、差（App − 標準）、差の95% cluster bootstrap CI。

| 分割 | 指標 | App | 標準 | 差 | 95% CI |
|---|---|---:|---:|---:|---:|
| development | Hit@1 | 0.7400 | 0.7100 | +0.0300 | [+0.0050, +0.0550] |
| development | Hit@10 | 0.9075 | 0.8800 | +0.0275 | [+0.0100, +0.0475] |
| development | MRR@10 | 0.7907 | 0.7648 | +0.0259 | [+0.0100, +0.0430] |
| development | nDCG@10 | 0.8186 | 0.7925 | +0.0261 | [+0.0117, +0.0414] |
| validation | Hit@1 | 0.7025 | 0.6950 | +0.0075 | [−0.0150, +0.0300] |
| validation | Hit@10 | 0.8950 | 0.8725 | +0.0225 | [0.0000, +0.0450] |
| validation | MRR@10 | 0.7677 | 0.7491 | +0.0186 | [+0.0025, +0.0359] |
| validation | nDCG@10 | 0.7985 | 0.7786 | +0.0199 | [+0.0043, +0.0367] |

Hit@10のvalidation区間は境界値0を含む。複数指標の区間は多重性調整をしていないので、確認的な有意差として解釈しない。

## 性能の扱い

- App APIの全経路レイテンシ: development p50/p95 204/269ms、validation 205.9/287.1ms。
- 標準BM25の記録はin-process rankerのp50/p95（約0.9〜1.0/2.9ms）であり、HTTPを含むApp APIと計時範囲が違う。速度の直接比較には使えない。
- App APIは品質改善の候補だが、現計測だけでは処理負荷とのトレードオフを評価できない。

## 解釈と次の検証

この結果は「標準BM25は常に劣る」とは示さない。タイトル・タグ由来クエリの多い保存記事メタデータに限り、現行の組み合わせ経路が候補として有望なことを示す。JAGOV validationでは標準BM25がA8混合をnDCG@10で+0.02730上回っており、ドメイン依存性が残る。

次に必要なのは、検索結果を見る前に自然検索クエリと正解対象を人手で固定した未使用分割で、App方式の優位を再検証すること。さらに、App方式の中の形態素/N-gram、希少語、共起、coverage、時間減衰を同一候補集合・同一クエリで分離し、品質差とランキング時間を測る。現状のクエリ生成方式のままでは利用者検索の一般化を主張しない。

## 再現

```powershell
npx.cmd tsx scripts/bench/compare_article_api_to_standard.ts local_article_corpus/benchmark/development-baseline.json local_article_corpus/benchmark/development-standard-bm25.json quality/e2e/artifacts/article-api-vs-standard-development-verified-20261023.json
npx.cmd tsx scripts/bench/compare_article_api_to_standard.ts local_article_corpus/benchmark/validation-baseline.json local_article_corpus/benchmark/validation-standard-bm25.json quality/e2e/artifacts/article-api-vs-standard-validation-verified-20261023.json
```

再計算器はクエリID、正解ラベル、抽出語、Top10列を検証し、共有正解対象をクラスタ化してbootstrapする。入力JSONのSHA-256、クエリ別指標、固定seedは対応するartifactに保存。
