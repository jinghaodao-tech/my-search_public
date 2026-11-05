# Moviesホールドアウト確認試験の事前登録

登録時点: 2026-10-20（実行前）

## 問い

Books開発・検証データで選ばれた候補「英語ストップワード除去＋形態素解析のみ」は、未使用のMoviesホールドアウトで現行方式よりHit@10を改善するか。

## 固定条件

- データ: Reddit-TOMT Movies、固定グループハッシュ分割のholdout。原本SHA-256は `99cafecf4432dfe6c5677774cf92cbce9b9ab570823edfe39454718c2b91296a`。
- ホールドアウトはこの確認試験の前に評価・閲覧していない。個別の検索クエリ・正解・結果を見ず、実行前にこの計画を保存する。
- 比較: `current` 対 `stopwords-morphology-only`。現行はアプリ既定設定。候補は英語ストップワードを検索キーワードから除き、形態素解析重みを1、N-gram重みを0にする。他の設定・検索API・文書集合・Top10判定は同一。
- 1回の実行で隔離SQLiteを一度だけ作り、同じ全holdoutクエリに両方式を適用する。`--final`消費台帳を1回だけ記録する。失敗・不都合な結果でも再実行しない。
- プライマリー評価項目: クエリ単位Hit@10の候補−現行の絶対差（percentage points）。
- 依存性: 同じ正解対象に属するクエリは独立とみなさず、`group_id` 単位で集約・リサンプリングする。
- 検定: グループごとの対応差を単位にした片側cluster sign-flip randomization test、固定seed、100,000回。帰無仮説は候補の平均Hit@10差が0以下。α=0.05。
- 不確実性: `group_id` を単位とした対応ありcluster bootstrap 100,000回、percentile 95%区間を報告する。全クエリを独立とする二項信頼区間は確認試験の根拠に使わない。
- 確認的な改善支持: randomization p<0.05 かつ cluster bootstrap 95%区間の下限>0。どちらかを満たさなければ「改善を統計的に支持できず」とする。
- Hit@1、レイテンシ、失敗例は副次・記述統計のみ。候補選択、反復追加、閾値変更に使わない。

## 解釈範囲

合格しても、結論はこの固定Movies文書集合・Reddit由来の映画想起質問・当該コード指紋に条件づけられる。my-search利用者の記事再発見性能や利用者全体への一般化を証明しない。Holdoutの一度限りの結果を見て追加調整しない。

## 実行コマンド

```powershell
python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/movies --stage holdout --final --compare-profiles current stopwords-morphology-only --out quality/e2e/artifacts/movies-final/paired-holdout.json
```

## 結果

ホールドアウト全件を登録する試行を開始したが、検索APIが1件約3.4秒で、現行方式だけを約94クエリ採点したところで現実的な完走時間を超えると判断し中止した。候補方式とのペア結果は得ていない。Moviesホールドアウトの消費台帳は残し、このホールドアウトを再利用しない。部分結果は確認・分析せず、成功率や方式差として報告しない。

## 計画からの変更

全件API評価が完走困難だったため、クエリ結果を確認する前に、未閲覧のMovies validationから独立な200対象群を固定ハッシュで選ぶ確認試験へ切り替える。Movies holdoutは封印したままとする。変更理由は処理時間のみであり、validationのクエリ・正解・スコアは選択に使わない。
