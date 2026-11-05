# BM25組み合わせ方式の追加探索

## 結論

単独方式に限らず、現行カスタム順位と標準形態素BM25をRRF（k=60）で融合し、適応bや補正を残す組み合わせも探索した。現時点で標準BM25に対する安定優位は得られていない。日本語記事メタデータでは現行カスタム方式が強く、JAGOVの質問検索では標準形態素BM25が強い。RRFは両者の中間になった。

本番ランキング・既存SQLite・ユーザーデータは変更していない。全比較は隔離ベンチマークDB上の探索結果であり、自然な個人検索への一般化を示さない。

## RRF方式

`A15-current-standard-rrf-k60` は、全候補に対してA0とS3をそれぞれ完全順位付けし、`1/(60 + rank)` を加算した。融合前に上位N件で切っていない。処理時間は融合そのものを測り、2つの順位計算は含まない。

### 日本語技術記事メタデータ development

2,484文書・400件の自己派生クエリ。出典と分割は既存の固定データを維持。

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | rank p50/p95 ms |
|---|---:|---:|---:|---:|---:|
| 現行カスタム A0 | 0.8173 | 0.9825 | 0.7906 | 0.7944 | 1.40 / 6.38 |
| 標準形態素 S3 (k1=1.2,b=0.75) | 0.8068 | 0.9825 | 0.7788 | 0.7832 | 0.33 / 2.38 |
| A0 + S3、RRF k=60 (A15) | 0.8130 | 0.9825 | 0.7857 | 0.7897 | 融合のみ 0.09 / 0.44 |
| 補正なしdual max-normalized、b=0.3 (S4) | 0.8177 | 0.9825 | 0.7911 | 0.7948 | 0.31 / 2.51 |

S3基準の対応ありクエリ比較では、A15のnDCG@10差は`+0.00617`、95%クラスタbootstrap CI `[+0.00140,+0.01154]`。ただしA15はA0より`-0.00431`であり、最良方式ではない。自己派生クエリであり探索的。

### JAGOV official FAQ development

22,794文書・614件。公式データ内のdevelopment split。正解対象クラスタbootstrapを使用。

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | rank p50/p95 ms |
|---|---:|---:|---:|---:|---:|
| 現行カスタム A0 | 0.5527 | 0.8534 | 0.5009 | 0.5067 | 40.89 / 157.34 |
| 標準形態素 S3 (k1=1.2,b=0.75) | **0.5695** | **0.8746** | **0.5193** | **0.5257** | 18.11 / 79.64 |
| A0 + S3、RRF k=60 (A15) | 0.5623 | 0.8616 | 0.5096 | 0.5154 | 融合のみ 2.05 / 8.35 |
| 現行補正 + corpus-adaptive b (A12) | 0.5682 | 0.8648 | 0.5196 | 0.5256 | 39.08 / 150.33 |
| 補正なしdual max-normalized、b=0.3 (S4) | 0.5566 | 0.8583 | 0.5047 | 0.5108 | 18.83 / 81.30 |

S3基準の対応あり比較:

| 方式との差 (variant - S3) | nDCG@10差 [95% CI] | Recall@100差 [95% CI] |
|---|---:|---:|
| A0 | `-0.016829` `[-0.030927,-0.002964]` | `-0.021173` `[-0.035831,-0.006515]` |
| A15 RRF | `-0.007250` `[-0.016809,+0.002003]` | `-0.013029` `[-0.026059,-0.001629]` |
| A12 adaptive b | `-0.001369` `[-0.017159,+0.014497]` | `-0.009772` `[-0.024430,+0.004886]` |
| S4 dual max-normalized | `-0.012997` `[-0.025815,-0.000213]` | `-0.016287` `[-0.029316,-0.003257]` |

RRFはA0より改善するが、標準S3を上回らない。adaptive bもS3に対する優位を示さず、標準より処理時間が大きい。

## RRF重みの感度

開発分割だけでcustom:standardの重みを`0.75:0.25`、`0.50:0.50`、`0.25:0.75`に固定して比較した。追加の重み探索で未使用分割を再利用していない。

| データ | 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 |
|---|---|---:|---:|---:|---:|
| 記事metadata dev | A16 custom 0.75 | 0.8171 | 0.9825 | 0.7904 | 0.7941 |
| 記事metadata dev | A15 equal | 0.8130 | 0.9825 | 0.7857 | 0.7897 |
| 記事metadata dev | A17 standard 0.75 | 0.8064 | 0.9825 | 0.7789 | 0.7835 |
| JAGOV dev | A16 custom 0.75 | 0.5581 | 0.8583 | 0.5060 | 0.5118 |
| JAGOV dev | A15 equal | 0.5623 | 0.8616 | 0.5096 | 0.5154 |
| JAGOV dev | A17 standard 0.75 | 0.5651 | 0.8713 | 0.5152 | 0.5221 |

基準単独方式との paired cluster bootstrap:

- 記事metadataではA16-S3のnDCG@10差`+0.01025`（95% CI `[+0.00319,+0.01780]`）。ただしA16はA0の0.8173にも届かず、A0自体が最良。
- JAGOVではA17-S3の差`-0.00449`（95% CI `[-0.00959,+0.00041]`）。区間は0を含み、非劣性を証明するよう設計された検定でもないため、同等とは認定しない。
- RRF重みを標準寄りにするとJAGOVの性能は標準に近づき、記事metadataではカスタム寄りが良い。重み比だけで両方の最良を取る結果は得られなかった。

## コーパス長によるrankerルーティング（A18）

追加仮説として、平均形態素文書長が40未満ならA0、それ以外はS3を選ぶルーターを試した。閾値40は今回の2コーパスの平均長（記事metadata 23.45、JAGOV 53.58）と既知の順位結果を見た後に設定した**post-hoc**値である。

| データ | 選択方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | rank p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|
| 記事metadata dev | A0 | 0.8173 | 0.9825 | 0.7906 | 0.7944 | 1.28 / 5.04 |
| JAGOV dev | S3 | 0.5695 | 0.8746 | 0.5193 | 0.5257 | 13.97 / 62.16 |

A18は各コーパスで事前に強かったrankerをそのまま選び、記事metadataではA0と完全一致、JAGOVではS3と完全一致した。この結果はルーティングアルゴリズムの汎化を示すものではなく、同じ評価コーパスを見て設計したoracle的な振り分けに近い。JAGOVのholdoutにA18を適用して独立確認したとは扱わない。新しいコーパスで閾値とルーティング規則を事前固定して評価するまでは採用しない。

## クエリ語とタイトル／タグの一致ルーター（A19/A20）

クエリごとにA0上位3件のタイトル／タグを調べ、フィールド一致があるときだけカスタム方式を使う案を試した。これはクエリ単位の一般的な信号を狙った探索で、qrelsや正解順位をルーティング条件には使っていない。

| 方式 | 固定ルール | 記事metadata dev: A0選択数 / nDCG@10 | JAGOV dev: A0選択数 / nDCG@10 | JAGOV標準S3 nDCG@10 |
|---|---|---:|---:|---:|
| A19 | 上位3件のtitle/tagいずれかに、長さ2以上の解析keywordが1つでも含まれる | 400/400 / 0.8173 | 609/614 / 0.5522 | 0.5695 |
| A20 | 上位3件の同一title/tagに解析keyword unitの50%以上が含まれる | 400/400 / 0.8173 | 425/614 / 0.5588 | 0.5695 |

A19はJAGOVの5問だけをS3へ切り替えるに留まり、A0を少し悪化させた。A20は切り替えを増やしたが、S3との差は`-0.010714`、95% paired cluster bootstrap CI `[-0.021368,-0.000342]`で負だった。記事側は全問A0となるだけでA0を超えない。どちらも不採用。

## JAGOV official holdoutの確認

このsourceは過去にdevelopment/validationを探索しており、holdoutはこの追加比較前には未評価だった公式splitだが、source全体として独立した新規データとはみなさない。最初に事前登録したA0対S3/S1/S4比較の結果:

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | rank p50/p95 ms |
|---|---:|---:|---:|---:|---:|
| A0 | 0.5542 | 0.8604 | 0.5074 | 0.5142 | 36.57 / 122.87 |
| S3 標準形態素 | **0.5824** | **0.8770** | **0.5334** | **0.5394** | 12.19 / 55.25 |
| S4 標準dual max-normalized | 0.5624 | 0.8633 | 0.5150 | 0.5219 | 13.02 / 60.19 |

S3-A0のnDCG@10差は`+0.028196`、95% CI `[+0.017677,+0.038990]`。A12 adaptive bは結果を見た後に追加された探索方式で、holdout上のnDCG@10は0.5621でS3に届かない。確認的な結果として扱わない。

## 判定

- 複数信号を組み合わせれば常に優位になるわけではない。A15は2つの順位の妥協点になり、どちらの領域でも最良ではなかった。
- corpus-adaptive bはJAGOVでA0を引き上げたが、S3を安定して超えず、holdoutでも差が残った。
- corpus-length router A18は既知コーパス上の各勝者を選ぶだけで、未知コーパスに対する優位性の証拠ではない。
- title/tag一致ルーターA19/A20はJAGOVで標準BM25より低く、記事側でもA0と同一だったため棄却する。
- 記事メタデータ上のA0優位と、FAQ質問上のS3優位が分かれた。自己派生クエリと公開FAQ質問というクエリ分布差を含むため、アプリ全体に共通の勝者を主張できない。
- 今回はベンチマークスクリプトのみ更新。本番ランキング採用は保留。次の有効な確認には、未探索のコーパスと自然な保存記事再発見クエリが必要。

## 再現ファイル

- `quality/e2e/artifacts/article-api-ablation/combination-rrf-exploration.json`
- `quality/e2e/artifacts/article-api-ablation/combination-rrf-vs-standard-paired.json`
- `quality/e2e/artifacts/article-api-ablation/weighted-rrf-exploration.json`
- `quality/e2e/artifacts/article-api-ablation/weighted-rrf-paired.json`
- `quality/e2e/artifacts/jagov-development/combination-rrf-exploration.json`
- `quality/e2e/artifacts/jagov-development/combination-rrf-vs-standard-paired.json`
- `quality/e2e/artifacts/jagov-development/weighted-rrf-exploration.json`
- `quality/e2e/artifacts/jagov-development/weighted-rrf-paired.json`
- `quality/e2e/artifacts/article-api-ablation/router-exploration.json`
- `quality/e2e/artifacts/article-api-ablation/router-paired.json`
- `quality/e2e/artifacts/jagov-development/router-exploration.json`
- `quality/e2e/artifacts/jagov-development/router-paired.json`
- `quality/e2e/artifacts/article-api-ablation/field-router-exploration.json`
- `quality/e2e/artifacts/article-api-ablation/field-coverage-router-exploration.json`
- `quality/e2e/artifacts/article-api-ablation/field-coverage-router-paired.json`
- `quality/e2e/artifacts/jagov-development/field-router-exploration.json`
- `quality/e2e/artifacts/jagov-development/field-coverage-router-exploration.json`
- `quality/e2e/artifacts/jagov-development/field-coverage-router-paired.json`
- `quality/e2e/artifacts/jagov-holdout-bm25-stability/frozen-comparison.json`
- `quality/e2e/artifacts/jagov-holdout-bm25-stability/adaptive-b-diagnostic.json`
- 事前登録: `quality/e2e/docs/BM25-JAGOV-HOLDOUT-COMPARISON-PREREGISTRATION-2026-10-23-ja.md`

探索方式追加後にholdoutへ新候補を当てていない。A12 holdout診断は方式選択後のpost-hoc値である。
