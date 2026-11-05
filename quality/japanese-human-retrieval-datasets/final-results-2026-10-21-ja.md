# my-search 日本語検索品質評価 最終レポート

評価日: 2026-10-21。既存の作業中変更と本番データは保持し、コミット・プッシュは行っていない。

## 結論

**Hit@10が95%を超えるとは主張できない。** 事前登録したJaGovFaqs holdoutの実API結果は701/1,024 (68.46%)、Clopper–Pearson片側97.5%下限は65.51%だった。標準BM25は747/1,024 (72.95%)で、対応比較でも標準BM25が上回った。JaGovFaqsはFAQの質問から対応回答を探すタスクであり、実際に保存した記事を利用者が再発見する成功率ではない。

## データと出典

| データ | 取得・評価状態 | 形式とラベルの性質 |
| --- | --- | --- |
| JaGovFaqsRetrieval | 全文書22,794、質問2,048、既存正解2,048件。固定分割: development 614 / validation 410 / holdout 1,024 | 公式FAQ質問と回答の対応関係。実際のmy-search検索ログやクリックラベルではない。取得元CC BY 4.0。取得元コーパスSHA-256 `0511e630f06d55a82bdd9fdb6ed096fbed3265d34081a2a7378710181b77d5fa`。 |
| MIRACL日本語 | 公式Wikipediaコーパス6,953,614文書を取得・検証。圧縮14 shard、1,065,120,400 bytes。評価用質問・qrelsは過去使用済み100 query/componentを除外し、dev 2,586 / validation 639 / holdout 752 | 人手作成検索質問と関連性判定。Wikipedia検索ベンチマークであり、保存記事の実利用ログではない。全文コーパスのmy-search API検索は未実施。 |
| JNQ | 論文・公式掲載ページを確認。実行環境で配布データ本体は取得できず | 2025年J-STAGE掲載版は16,641質問、2024年会議論文は16,871質問と記載が異なる。両方とも検索ログ由来と説明する。J-STAGE記事ページの補足資料は0件で、確認できた公式な取得可能データ本体の配布先はない。不存在とは断定しない。 |

JaGovFaqsの[公式データセットページ](https://huggingface.co/datasets/mteb/JaGovFaqsRetrieval)とMIRACLの[公式データセットページ](https://huggingface.co/datasets/miracl/miracl)を使用した。JNQは[J-STAGE掲載版](https://www.jstage.jst.go.jp/article/jnlp/32/2/32_497/_article/-char/ja)と[2024年会議論文](https://aclanthology.org/2024.starsem-1.5/)で質問数が異なるため、取得可能な版とデータ本体を特定できるまで評価に含めない。

### 評価容易性の監査

JaGovFaqs holdout 1,024件では、正解回答タイトル/本文に正規化後の質問全文が含まれる例は0件。質問の文字bigramの80%以上が正解文書にある例は29件 (2.8%)。API解析語7,952語のうち正解タイトル/本文に文字列として含まれるのは4,911語 (61.8%)。後者は日本語の表記変化・形態素境界を考慮しない単純部分文字列検査であり、意味的一致率ではない。正解回答本文の中央値は151文字。このデータは単純な質問文のコピーマッチだけで高得点になる評価ではない。

## 検索条件と事前登録

事前登録は[事前登録書](jagov-holdout-preregistration-2026-10-21-ja.md)。全22,794文書を隔離SQLiteにアプリの保存形式で投入。保存カードUIと同じ `POST /api/search/terms` → `POST /api/cards/search` を使用し、APIエラー・無効応答は失敗として計上した。

- 選択方式: `theory`。holdoutを見る前に410件のvalidationで選択し、その後固定。
- `k1=1.8`, `b=0.8`, `lambda=0.02`, `contextBonus=2.2`。キーワードは実APIの解析結果。形態素/N-gram重みはUIが送らず、`runPipeline`既定の`0.3/0.7`。重複排除無効 (`dedupThreshold=1`)、archive閾値0.5、結果上限50。
- 実装git HEAD: `be29373f0381c1b58af329932190b56c86f20819`。dirty worktreeを含む指紋: `sha256:3501d715fa89913d1a69aa6b56e1c2029fd72fde880ee5c2bd1eefcb785ec0c0`。
- holdoutは1,024個の事前固定groupで各1質問、1正解文書も全件相互に異なる。各groupを独立推定単位とした。
- 主仮説 `H0:p<=0.95`、片側alpha=.025。passに必要な最低成功数は987/1,024。

## 最終ホールドアウト

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | Hit@100 | Hit@1000 | レイテンシp50/p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| theory UI相当・実API | 410/1,024 (40.04%) | **701/1,024 (68.46%)** | 0.4927 | 0.5390 | 未測定 | 未測定 | 2,476.8 / 3,148.0 ms |
| 独立標準BM25、形態素トークン | 436/1,024 (42.58%) | **747/1,024 (72.95%)** | 0.5267 | 0.5757 | 889/1,024 (86.82%) | 955/1,024 (93.26%) | 23.23 / 49.24 ms |

API方式のHit@10片側97.5%正確下限は**65.51%**、`p=0.95`に対する上側確率は1.0、認定不合格。標準BM25も下限70.12%で不合格。APIの失敗応答は0件。API p50/p95はHTTP解析・SQLiteロード・スコア計算を含むend-to-end時間。標準BM25のp50/p95はトークン・統計をメモリに準備した後のスコア計算だけなので、直接のレイテンシ比較ではない。

対応比較では標準BM25のみ成功79件、API方式のみ成功33件、両者同じ912件。差はAPI - 標準BM25 = **-4.49 percentage points**、厳密McNemar両側 `p=1.64e-5`。group bootstrap 20,000反復の95%区間は[-6.54, -2.44]ポイント。今回のJaGovFaqs分布では標準BM25の方が明確に高かった。これは方式の普遍的優越や保存記事検索の性能を証明するものではない。

## 原因分析と改善

- developmentで成功群と失敗群の解析語・正解本文の文字列一致率は79.7%対43.9%。語彙不一致が主要な失敗要因の一つと示唆された。
- 開発診断では614件中472件が10件未満の結果で、失敗例のうち54件は標準BM25ならTop10。候補生成・スコア閾値・ランキングの違いを調べる必要が残った。
- 正解と異なるFAQ回答が、定型文のため5文字shingle Jaccard 0.86765となり、重複排除閾値0.8で誤統合される具体例を確認。重複排除を無効にすると、固定development 100件ではHit@10が72から74へ変化した (2改善、0悪化、McNemar p=.5)。小標本で有意な改善とは言えないが、別の意味を持つ保存カードを消さない安全上の修正として、保存カード検索の既定重複排除を無効化した。明示的に閾値を指定した場合はその設定を維持する。
- validation 410件のdirect `runPipeline`比較ではTheory 303/410 (73.90%)、現行Impl 273/410 (66.59%)で、Theoryが7.32ポイント高かった (cluster bootstrap 95% CI +4.15〜+10.49、exact McNemar p=9.25e-6)。Theory対標準BM25はvalidationでは差を確認できなかった (Theory 73.90%、標準74.88%、p=.644)。validation選択と別holdout評価の結果が一致しないこと自体が、validationだけから最終性能を断定できない実例となった。
- API最終試験でTheoryは701件、標準BM25は747件。改善の追加反復をholdoutに適合させてはならないため、この結果を受けた再調整は行っていない。

主な変更: `routes/cards_routes.ts` の保存カード検索既定を重複排除無効に変更、`public/app.js`・`public/index.html`・`public/js/search_workflow_ui.js` の既定値と表示を統一、`tests/cards.test.ts` と `e2e/core-flows.spec.ts` に類似FAQの意味的別カードを残す回帰を追加。評価器の診断フラグと閾値説明も修正した。

## MIRACL全文コーパスを実API評価しなかった理由

コーパス原本と14 shardは取得・行数・重複なし等を検証済みだが、my-searchの保存カード検索ルートは各リクエストで `ctx.loadCards()` から全カードをNode.jsオブジェクト配列へ展開する。22,794文書のJaGov実API測定でも、APIプロセスのサンプル最大RSSは2,316,939,264 bytes (約2.16 GiB)、heapUsedは最大1,915,130,840 bytes (約1.78 GiB)。同じAPI方式で6,953,614文書をロードするのは、このPCの64 GiBメモリでは安全な実験とは見なせないため投入しなかった。これは実測ベンチマーク実行ではなく、現行ルートと観測メモリからの実行可否判断である。MIRACLは未評価とし、JaGov/MIRACLを混ぜない。

## 検証・再現成果物

- 主API結果: `local_article_corpus/japanese-human-retrieval/jagov-holdout-db/jagov-holdout-theory-api.json`
- 標準BM25: `local_article_corpus/japanese-human-retrieval/jagov-holdout-db/jagov-holdout-standard-bm25.json`
- 統計・対応比較: `local_article_corpus/japanese-human-retrieval/jagov-holdout-db/jagov-holdout-paired-statistics.json`
- データ・評価用DBは `local_article_corpus/` 配下でGit管理外。本番カード・メモ・Reader DBは使用していない。
- 既存回帰確認: `tests/cards.test.ts` 24/24、該当Playwright E2E 1/1、`npm run typecheck` 成功（本評価前の実行）。最終レポート追記後にも再実行して報告する。

## 次に必要な改善

1. 保存カード検索で全カードのNodeオブジェクト化を避ける永続全文索引・候補生成を設計し、同じUI/APIルートで再ベンチマークする。
2. API方式と標準BM25の差を、検索語・候補再現率・閾値除外・順位補正に分ける。今回のholdoutは以後の調整に使用しない。
3. MIRACL全文書で試す場合は、ストリーミング取込またはSQLite FTS5等の索引を実装し、6.95M全件を検索する別の未使用評価計画を立てる。
4. JaGovFaqsは既存FAQ対応ラベルに限る。利用者の保存記事再発見を95%と主張するには、同意を得た実利用セッションによる別の代表標本が必要。

実施できなかった事項: MIRACL 6,953,614文書のmy-search実API検索、JNQ配布データの取得、実利用者セッションの統計評価。いずれも代替データ・架空クエリで埋めていない。

## 2026-10-22 追補: MIRACL全コーパスAPIホールドアウト

上記は2026-10-21時点の結果である。その後、隔離SQLite FTS5に収録したMIRACL日本語公式全コーパスを使い、事前登録済みの726クラスタ代表を、実際の `/api/search/terms` → `/api/run` 経路で一度だけ評価した。検索条件・コード指紋・代表選択・閾値をholdout結果の取得前に固定し、評価結果を見てからの再調整・再評価はしていない。したがって、以下が本追補時点のMIRACL評価結果であり、先の「MIRACL全文書のmy-search実API検索は未実施」という記述はこの実行によって更新される。

| 方式 | Hit@1 | Hit@10 | Hit@50 | MRR@10 | nDCG@10 | API p50/p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 形態素FTS5 BM25、タイトル補正なし | 139/726 (19.15%) | 495/726 (68.18%) | 495/726 (68.18%) | 0.2814 | 0.2509 | 2,020.9 / 6,816.8 ms |
| 形態素FTS5 BM25 + title coverage rerank (weight 0.2) | 139/726 (19.15%) | **515/726 (70.94%)** | 515/726 (70.94%) | 0.2879 | 0.2586 | 2,016.1 / 6,909.5 ms |

候補方式のHit@10片側97.5% Clopper–Pearson下限は **67.48%**。事前基準の95%を明確に下回り、95%超の認定は **不合格**。標準FTS5の下限は64.66%で、こちらも不合格。APIエラーは両方式0件。結果数はAPI上限50件だが、今回の返却ではHit@50がHit@10と同値だった。これは「Top50でも10位以降で正解を追加回収しなかった」ことを示し、Hit@100/1000を測ったことにはならない。

対応比較では両方式成功490、基準のみ成功5、title rerankのみ成功25、両方失敗206。差は **+20/726 = +2.75ポイント**、exact McNemar両側 `p=0.0003249`、クラスタbootstrap 20,000反復の95%区間は **+1.38〜+4.27ポイント**。この固定MIRACL分布上ではtitle coverage rerankが基準より改善した証拠がある一方、絶対Hit@10は約71%にとどまる。相対改善の有意性は95%超の絶対性能を意味しない。

parserのp50/p95は7.39/11.86 ms。API検索時間は候補方式2,016/6,909 ms、基準2,021/6,817 msで、この一回の実行からレイテンシ差の優劣は主張しない。プロセスpeak RSS 591,032,320 bytes、heapUsed 169,393,584 bytes。評価時の全文書・形態素FTS・N-gram FTSはいずれも6,953,614件。726 queryの対比較総実行時間は3,716.3秒。環境・API境界・設定の詳細は[事前登録・実行記録](miracl-holdout-preregistration-2026-10-21-ja.md)と隔離成果物を参照。

この結果の対象はMIRACL日本語Wikipedia passage retrievalの726代表queryであり、保存記事の実利用再発見率ではない。代表は各positive-qrel connected componentから1件選んだため同じ正解関連成分を重複計上していないが、726成分を母集団から独立同分布抽出したことまでは保証しない。実利用95%認定には、別途、同意を得た利用者の自然検索・正解確認データが必要である。

### 2026-10-22 評価器バグの訂正

後続のコード監査で、`run_miracl_holdout_api_paired.ts` の `hitMetrics()` がTop50の最初の正解順位に対して `first >= 0` をHit@10およびMRR@10へ使っていた不具合を発見した。Top10だけから再計算した値は次のとおり。Top50全IDは保存されていないためHit@50は当時の保存済みフラグを示す。

| 方式 | Hit@1 | 修正Hit@10 | 保存Hit@50 | 修正MRR@10 | nDCG@10 |
|---|---:|---:|---:|---:|---:|
| 形態素FTS5 BM25 | 139/726 | 337/726 (46.42%) | 495/726 (68.18%) | 0.2710 | 0.2509 |
| title coverage rerank 0.2 | 139/726 | 352/726 (48.48%) | 515/726 (70.94%) | 0.2770 | 0.2586 |

旧Hit@10（495/515）、MRR@10（0.28136/0.28790）、95%信頼下限、旧対応比較とbootstrap区間は誤ったHit@10を含むため無効。nDCG@10は保存Top10から計算されており、この不具合の影響を受けない。修正Hit@10の対応内訳は両方334、baselineのみ3、candidateのみ18、両方失敗371、差+15/726。事後訂正のexact McNemar両側p=0.00149は消費済みholdout上の監査値であり、独立検定として扱わない。独立評価は `NOT_EVALUABLE`。

監査コード・回帰テスト: `miracl_metrics.ts`, `audit_miracl_hit10_checkpoint.ts`, `tests/miracl_metrics.test.ts`。再現結果: `artifacts/miracl-holdout-metric-correction-20261022.json`。Top50の実返却件数・順位11〜50を確定するAPI再生は未完了である。
