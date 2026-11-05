# MIRACL日本語ホールドアウト事前登録

## 状態

**統計計画を事前固定。検索設定はvalidation完了後、holdoutを開く前に追記して固定する。** その追記とコード指紋の記録が終わるまで `holdout.jsonl` は読まず、評価を実行しない。

## 対象と推定範囲

- データ: MIRACL Japanese official full-corpus retrieval。
- 最終分割: `local_article_corpus/japanese-human-retrieval/miracl-eval/holdout.jsonl`。manifest記載752 query、726 positive-qrel connected components。
- 以前使用した100 queryと接続成分は分割生成時に除外済み。manifest記録の除外数・ハッシュを評価前に再検証する。
- 主評価単位: 各connected componentから結果を見ずに決定した代表queryを1件選び、726 component-level observationを用いる。
- 結論の対象は、MIRACL Japanese Wikipedia passage retrievalの公式dev-derived holdout分布に限る。my-searchで保存した記事の自然再発見率や実ユーザー全般には一般化しない。

## 主指標と判定

- 唯一の主指標: 選定した代表queryに対するAPI Hit@10。
- APIエラー、タイムアウト、空の不正応答は失敗として数える。正解IDが返却Top10に1つでもあれば成功。
- 帰無仮説 `H0: p <= 0.95`、対立仮説 `H1: p > 0.95`、片側 `alpha=0.025`。
- 726件の場合、成功が **702件以上**（失敗24件以下）かつ片側97.5% Clopper–Pearson下限が0.95を超えるときに限り、このベンチマーク分布で95%超を支持する。
- 二項モデルで `p=0.98` のときの事前検定力は約0.99286。これは各component代表が独立同分布とみなせる場合の計画値であり、現実の独立性を証明するものではない。

## 代表queryの選定

holdout query本文・正解ラベル・検索結果を参照した選択を禁止する。各 `group_id` 内で `SHA256("miracl-ja-holdout-representative-v1\\0" + query_id)` が辞書順最小のqueryを代表として採る。ソルト、アルゴリズム、最終代表ID一覧とそのSHA-256を、結果取得前に成果物へ記録する。group_idが重複・欠落する場合は実行を中止し、分割manifestを先に監査する。

## 比較方式・固定条件

アプリ方式と標準BM25は同じ代表query、同じ全6,953,614文書、同じ `/api/search/terms` query analysis、同じ有効な正解ID、同じTop10成功定義で評価する。

- アプリ方式: validationで選択した検索エンジン、mode、トークナイザ、RRF/再順位設定、フィルタ、重複排除、結果数をholdout前にここへ追記する。
- 比較方式: SQLite FTS5 `bm25()` の標準BM25。検索解析結果と全コーパスはアプリ方式と共有し、固有の追加補正は適用しない。
- 検索対象全体はMIRACL全コーパス。qrels正解文書だけに絞った候補集合は禁止。
- 1回限りの最終実行前に、DB全件数、2つのFTS行数、qrels/holdout SHA-256、コードfingerprint、設定、OS/Node/SQLite版、実行コマンドを記録する。
- 実行開始後にコード・検索設定を変更しない。評価結果を見て変更した場合は認定不可とし、同じholdoutを再使用しない。

## 比較・副次指標

- 標準BM25との差は同じ726代表queryで対応比較する。discordant component数を示し、exact McNemar両側p値を報告する。
- Hit@1、MRR@10、nDCG@10、Hit@100、Hit@1000、p50/p95 latency、RSS/heapは副次指標。主指標の合否と混同しない。
- 残りの26 query（752全件中、代表でないquery）は記述的なクラスタ単位解析に限り、主判定の標本数へ加えない。
- 「95%超の支持」と「BM25より改善」は別の問いとして判定する。BM25に勝っても絶対基準を満たすとは限らず、その逆も同様。

## データ・再現性の確認

基準ファイルは `miracl-eval/manifest.json`。既知のholdout SHA-256は `83e3249f46a87f26032c0d336c15ccc048312eab84a1135d908e46dd6677acbc`、qrels SHA-256は `4f8ae6d0998dfdfe2fcc5e6cbad215e883fbc3089b4edbb20c8df1a93462a4ca`。実行直前に再計算し、一致しなければ停止する。

MIRACLの質問・人手関連性ラベルはWikipedia passage retrieval由来であり、実際に保存した記事を人が再発見する試行ではない。結果はこのデータとタスクの範囲に限定して報告する。

## 2026-10-22 事前登録追補（holdout未読）

### 比較する検索アルゴリズム

最終測定前にdevelopment/validationだけで設定を選び、以下を同一クエリ・全コーパスで比較する。各方式の実装をソースで確認し、名前だけを同一アルゴリズムとして扱わない。

1. アプリ記事検索 `ARTICLE_SEARCH_ENGINE=fts5-rerank`。FTS5で候補を作り、既存 `runPipeline` で再順位付けする。
2. アプリ記事検索 `ARTICLE_SEARCH_ENGINE=fts5-rrf`。形態素FTS5順位とN-gram FTS5順位を完全順位でRRF融合し、同じ `/api/run` 経路から返す。
3. 独立対照の形態素FTS5 `bm25()`。
4. 独立診断のN-gram FTS5 `bm25()`。形態素方式とトークン方式の差を切り分ける。
5. アプリ既定 `ARTICLE_SEARCH_ENGINE=bm25` は全記事をNode.jsへロードする実装である。既知の22,794文書実APIで約2.16 GiBの最大RSSを観測しており、6,953,614文書へ線形外挿すると約650 GiBとなるため、全コーパスでは実行しない。実装・小規模結果はアルゴリズム確認として示し、全コーパス数値を捏造しない。

`SEARCH_ENGINE=hybrid` は保存カード用であり、MIRACL記事コーパスの現在の経路では標準比較対象にできない。記事検索用 `bm25`、候補再順位付け、RRFとは区別して報告する。方式ごとの同じ全コーパス検索、候補数、Top10、APIエラー、p50/p95、RSS/heapを記録する。実行可能な方式に限り、主評価のほかHit@1、MRR@10、nDCG@10、Hit@100/1000も報告する。

### 2026-10-22 追加追補: 外部検索エンジン比較（holdout未読）

アプリ内アルゴリズムだけでなく、異なる検索エンジンの全体比較を副次・探索評価として追加する。一次指標、一次比較、726クラスタ代表、閾値は変更しない。

- Meilisearch v1.55.0: 公式Windowsバイナリを使用し、実行ファイルSHA-256を公式GitHub Release APIのdigestと照合する。全6,953,614文書を同じMIRACLコーパスから投入し、標準の全文検索ランキングと日本語トークナイズを使う。`title` と `body` だけを検索対象にし、埋め込み・外部API・手動synonym・クエリ別設定は使わない。初期のtypo tolerance等の標準設定を変更しない。
- Typesense v30.2: Dockerが利用可能な場合のみ公式コンテナを使い、`title` と `body` を同じ全コーパスで索引化する。`query_by=title,body` と標準text-matchランキングを使用し、カスタム同義語・手動トークン生成・クエリ別の設定は加えない。Dockerが利用できない場合は未実施とし、別バージョンや別エンジンの結果で代用しない。
- それぞれで文書件数、投入時間、索引サイズ、ピークRSS/heap、検索APIレイテンシ、タスク失敗を記録する。検索はMIRACLの同一validation代表queryと全コーパスで行う。各エンジンの検索入力は同じ原文queryとし、エンジン固有の解析・日本語トークナイズを含むエンドツーエンド比較と明記する。アプリ内の`/api/search/terms`で解析済みのFTS比較とは同一条件のランキング比較ではないため、別表に分ける。
- Meilisearch/Typesenseは外部製品の標準動作を比べる副次比較であり、結果を見て設定を調整しない。追加の設定探索を行った場合はそのquery集合を探索用と明記し、同じholdoutでの合否を主張しない。
- 収集記事コーパスでの保持語/タグ記憶能力は別問題であり、MIRACLには実利用タグも利用者の想起手掛かりもない。ここでの検索エンジン順位を、利用者がタイトル・固有名詞・タグを覚えていた場合の実測と解釈しない。

### 2026-10-22 実行可能性追補（holdout未読）

- Meilisearch v1.55.0は、JaGovFaqsRetrieval全22,794文書・開発614クエリでのみ完全評価した。JaGovの全タイトル・全タグが空であり、これはtitle/tag記憶評価ではない。Meilisearch入力は原文queryなので、MIRACL用FTSの共通解析語ランキング比較とは別のエンドツーエンド結果として保存する。
- MIRACL全件Meilisearchは未実施。先頭100,000文書の規模測定は136秒、indexSize約1.19 GB、Meilisearch process peak working set約3.18 GBだった。単純外挿は実測値ではなく、全件の実施可否を保証しない。空きRAM約37 GBに対し外挿値が大きいため、全件構築を開始せず、100k測定を品質結果として使わない。
- Typesense v30.2は未実施。Docker Desktop起動後もDocker Engine pipeが利用可能にならず、WSLもアクセス拒否となったため、公式Docker経路を実行できなかった。未実施を他の製品・版の結果で代用しない。
- これらの外部エンジン比較は、MIRACL 726クラスタの一次統計判定・採用方式を変更しない。MIRACLの外部エンジン値は無しとして扱い、外挿・部分コーパスHitを全件ランキング精度として報告しない。
- Meilisearch/Typesense、SQLite FTS5とmy-searchの実測範囲・別々の計時境界・メモリ制約は [`docs/external-search-engine-comparison-2026-10-22-ja.md`](../../docs/external-search-engine-comparison-2026-10-22-ja.md) に記録する。

### 2026-10-22 事後診断の隔離とタイトル再順位プロトタイプ（holdout未読）

- MIRACL validation 581件の標準FTS5 BM25結果、候補再現率、語彙/title/proper-noun overlap集計を既に閲覧した。このvalidationは今後、未使用・確認的データとして扱わない。層別結果とそこから導いた仮説は探索的証拠に限る。
- 開発分割から結果非依存に抽出した100代表queryで、形態素FTS BM25のtop-1000候補集合を固定し、正規化したBM25順位にtitle parsed-term coverageを加えるローカル評価プロトタイプを実施した。探索した重みは0, .05, .1, .2, .4。重み.2はHit@10 53/100（基準51/100）、MRR@10 +.0256、nDCG@10 +.0180。基準のみ成功0、title-rerankのみ成功2、両方成功51、両方失敗47、exact paired McNemar p=.5。係数探索を含む開発用結果であり統計的改善を主張しない。
- 2026-10-22に重み.2を固定したvalidation 581件の一回確認を実行済み。Hit@10は287/581から299/581（+12件）、MRR@10は.286から.301、nDCG@10は.270から.285。対応比較の不一致は基準のみ6、試作のみ18。追加再順位p50/p95は173/292 ms。この結果はvalidationが診断・仮説形成に使われた後の探索値であり、独立・確認的評価や統計的改善証明ではない。重みをvalidation結果に合わせて調整しない。Title-rerankは候補生成を変更せず、FTS top-1000外の正解を救えない。
- このプロトタイプは本番`runPipeline`、保存カードAPI、既定ランキングへ未接続。validation確認またはMIRACL holdoutの前に、本番コードへ採用しない。MIRACL holdoutの一次評価方式・コード指紋・判定閾値は本番候補が固定されるまで未確定であり、holdoutは読まない。

### 想起手掛かりの診断

MIRACLには利用者が何を記憶していたかのラベルがない。そこでholdoutを開く前に、validationで定義を確認・固定し、最終評価でも結果を見ず機械的に次の観測可能な代理層を付記する。

- `title_overlap`: `/api/search/terms` が返した検索語が、正解文書のtitleに一致するか。
- `proper_noun_overlap`: Kuromojiの固有名詞トークン（品詞細分類）をクエリから抽出し、正解文書のtitle/bodyに一致するか。利用する同じ辞書・抽出コード・正規化を記録する。
- `body_only_or_no_lexical_clue`: titleに一致せず、本文には一致する場合と、本文にも一致しない場合を分ける。

これは「titleや固有名詞を本当に覚えていた」ことの実測ではなく、正解文書との文字列一致に基づく診断層である。title/bodyを使った層別が正解文書に依存する点も明記し、利用者の記憶状態へ一般化しない。MIRACLの文書にタグ欄はなく、タグ記憶条件は測定不能とする。タグ検索の実利用評価は、実タグと本人が自然に入力した検索語・後日確定した正解を、同意を得て収集する別研究で行う。検索語やラベルを人工生成して補完しない。

この追補は一次指標・726クラスタ代表・成功定義・有意水準・合格閾値を変更しない。validationで方法とコードを固定し、holdoutのquery本文・qrels・結果はその後まで参照しない。

### 2026-10-22 最終実行の事前固定（holdout検索前）

この節を最終固定とし、上記の「検索設定未確定」「方式は本番候補が固定されるまで未確定」という過去時点の記述を更新する。以下の検索設定でホールドアウトを一度だけ実行する。

- 主候補: `ARTICLE_SEARCH_ENGINE=fts5-title-rerank`、`ARTICLE_SEARCH_TITLE_RERANK_WEIGHT=0.2`。validation 581件を含む探索済みデータを使って選ばれた固定値であり、最終評価後に変更しない。
- 対照: 同じ実API・同じクエリ解析・同じFTS5形態素候補を用い、タイトル重みだけを `0` とする標準形態素FTS5 BM25。
- API: 各代表queryについて `POST /api/search/terms` を1回、続けて `POST /api/run` を各重みで1回ずつ呼ぶ。重みの実行順は代表ID順の偶奇で交替する。`modeId=custom`、解析APIのkeywords、`options={dedupThreshold:1, archiveScoreThreshold:-1, resultLimit:50}`、`filters={excludedTerms:[],sources:[],status:'all'}` を固定する。config payloadは `k1=1.8,b=0.8,lambda=0.02,contextBonus=2.2` とするが、title-rerank経路はBM25の全コーパス順位を直接使うためこれらのBM25係数・context・time decayは順位に適用されない。
- 実行コマンド: `npm exec tsx -- quality/japanese-human-retrieval-datasets/run_miracl_holdout_api_paired.ts local_article_corpus/japanese-human-retrieval/miracl-full-fts.sqlite local_article_corpus/japanese-human-retrieval/miracl-eval/holdout-representatives-enriched.jsonl local_article_corpus/japanese-human-retrieval/miracl-eval miracl-holdout-api-20261022`。Nodeの直接型ストリッピングでは拡張子`.js`から`.ts`への解決ができず、アプリimport前に停止したため、query/resultは未読のまま。プロジェクトのtsxランナーを固定実行手段とする。
- 同一プロセス・同一の6,953,614記事・同一のSQLite形態素FTSで対比較する。結果上限は検索API/UIが返す50件。主指標はHit@10、副指標はHit@1、Hit@50、MRR@10、nDCG@10、API所要時間、RSS/heap。Hit@100/1000はこの固定API応答からは取得できないため今回の副指標から除外し、別経路の評価値で置換しない。
- parser/APIエラー、timeout、空または不正な応答は失敗として固定する。parserが失敗した場合は両検索方式を失敗に計上する。timeoutは120秒応答/150秒deadline。結果は1代表queryごとにcheckpointし、実行中断時は同一fingerprint・同一順序で未完了分のみ再開する。設定変更・結果を見ての再実行は禁止。
- 726代表IDはquery本文/qrelsを選定に使わず、全3977行のsplit metadataから `SHA256("miracl-ja-holdout-representative-v1\0" + query_id)` が各groupで辞書順最小の行を選んだ。選定入力SHA-256 `1e3ec737cec1f7f0ea7979b896b6703ec4c171b440f436153f166231292ed5d8`、選定JSONL SHA-256 `3daacea9d204a3e90b2bb45f95fa74da5ecf1ce4772d42b60cd38d91f95859ad`、ID一覧SHA-256（IDを改行連結）`37f233f5ba40451b38894a15fe38cc07517ec8f069ca455656d654a48b1e5dd3`。query本文とqrelsはまだ結合していない。
- データSHA-256はholdout `83e3249f46a87f26032c0d336c15ccc048312eab84a1135d908e46dd6677acbc`、qrels `4f8ae6d0998dfdfe2fcc5e6cbad215e883fbc3089b4edbb20c8df1a93462a4ca`、manifest `56a2c7f13bd11b5ab890aa4e0c5cb1e6c4343141ffd7997f4ca7fcc11cccfa94`。いずれもmanifestと一致。
- 実行コード指紋（次の相対パス順に `path<TAB>file-SHA256` をLFで連結したUTF-8をSHA-256）: `8b6688cb5c728c27d2d6f7f2db3edd407f32700eb8e9f3bb28f3e0521acc2e5b`。対象: `app.ts`, `routes/search_routes.ts`, `repositories/articles_repository.ts`, `services/title_rerank.ts`, `services/query_analysis.ts`, `services/discover_service.ts`, `services/route_context.ts`, `db/database.ts`, `db/migrate.ts`, `schemas/api_schemas.ts`, `quality/japanese-human-retrieval-datasets/run_miracl_holdout_api_paired.ts`, `quality/japanese-human-retrieval-datasets/prepare_miracl_holdout_representatives.mjs`, `quality/japanese-human-retrieval-datasets/japanese-human-retrieval-datasets/select_cluster_representatives.mjs`, `quality/japanese-human-retrieval-datasets/japanese-human-retrieval-datasets/evaluate_representative_gate.mjs`, `quality/japanese-human-retrieval-datasets/japanese-human-retrieval-datasets/test_representative_evaluation.mjs`, `quality/japanese-human-retrieval-datasets/test_prepare_miracl_holdout_representatives.mjs`, `tests/article-search-fts.test.ts`, `package.json`, `package-lock.json`, `tsconfig.json`。
- Git HEAD `be29373f0381c1b58af329932190b56c86f20819`。評価用の作業ツリー変更はGit HEADに含まれないため、上記fingerprintを評価版の同定に使う。OS Windows 10.0.26300.9711 x64、Node.js v24.16.0、better-sqlite3 12.11.1、SQLite 3.53.2。
- 事前テスト: `npm run typecheck`成功、検索FTS回帰9/9成功、代表選択・ゲート・準備テスト8/8成功。通常sandboxでVitestが一時ファイルrenameのEPERMとなったが、同テストを承認付き実行で9/9確認。

この追補・ID hash・fingerprintの記録をquery本文/qrelsの結合および最終検索結果の取得より先に完了する。主評価は726 component代表のみで、成功702以上かつClopper–Pearson片側97.5%下限が0.95超の場合のみ、このベンチマーク分布で95%超を支持する。結果は保存記事の実利用性能へ一般化しない。

## 2026-10-22 実行結果（事前登録後）

上記条件でholdoutを一度だけ実行した。実行後の結果を記録する。以下は事前登録値を変更するものではなく、同じholdoutを使った再評価・再調整を許可しない。

- 完了: 726/726代表query。検索対象は6,953,614文書、形態素/N-gram index各6,953,614。parser/APIエラーは0。
- 比較候補 `titleCoverageRerankWeight02`: Hit@10 515/726 (0.70937)、Hit@1 139、Hit@50 515、MRR@10 0.28790、nDCG@10 0.25864、API p50/p95 2,016.14/6,909.46 ms。
- 対照 `standardMorphologicalFts5`: Hit@10 495/726 (0.68182)、Hit@1 139、Hit@50 495、MRR@10 0.28136、nDCG@10 0.25094、API p50/p95 2,020.93/6,816.78 ms。
- 事前登録した95%超判定: 候補の片側97.5% Clopper–Pearson下限 0.67484、null-tail p-value 1。**FAIL**（95%超を支持しない）。対照下限は0.64656、同じく不合格。
- 対応差: +20/726 = +0.02755。両方成功490、baselineのみ5、candidateのみ25、両方失敗206。exact McNemar両側 `p=0.0003249142`。cluster bootstrap 20,000反復95% CI `[0.01377, 0.04270]`。このMIRACL分布ではtitle rerankの相対改善が示されたが、絶対Hit@10の95%超とは別の判定である。
- parser p50/p95 7.39/11.86 ms。peak RSS 591,032,320 bytes、heapUsed 169,393,584 bytes、全評価3,716,274.91 ms。計測境界は同ファイル内のrun summaryを参照。
- 実行結果SHA-256: candidate `8abc5513f67770bdf055174a36a29a6572ba213219bf05d6d1b61cb12fa13546`、baseline `5dc639d5a1f97df75717492f025f49f2259764bf498c92a1d7572e80129041d0`、代表選択 `d33ed5b2479ab944f31b206fb04227fe7dc3d556849ef49f4ea531c3d53e090f`。
- 統計ゲートJSON: `local_article_corpus/japanese-human-retrieval/miracl-eval/miracl-holdout-api-20261022.gate.json`。候補JSONL: `miracl-holdout-api-20261022.candidate.jsonl`、対照JSONL: `miracl-holdout-api-20261022.baseline.jsonl`。これらはignoredな隔離データ配下にあり、ユーザーのカードDBは変更していない。

Hit@50がHit@10と同値なのは、実際のAPI上位50件で11〜50位に新たな正解がなかったためであり、Hit@100/1000を測定したことを意味しない。結論の適用範囲はMIRACL日本語Wikipedia検索に限られ、保存記事の実利用成功率には一般化しない。

### 2026-10-22 事後監査訂正

後続監査でrunnerのHit@10/MRR@10計算が誤っていたと判明した。`first` はTop50から検索されていたが、Hit@10およびMRR@10を `first >= 0` で計算していた。保存Top10の再計算ではbaseline Hit@10=337/726、MRR@10=0.27102、title-rerank Hit@10=352/726、MRR@10=0.27701。保存Hit@50は495/726、515/726で、Top10から11〜50位を独立再確認できるIDは保存されていない。nDCG@10はTop10に基づくため旧値のまま。旧Hit@10・MRR@10・信頼下限・McNemar/bootstrap値は無効。修正後の対応差は+15/726、exact McNemar両側p=0.00149だが、消費済みholdoutの事後的監査であり独立な統計認定ではない。95%超の認定は `NOT_EVALUABLE`。詳細・再現artifactは [`final-results-2026-10-21-ja.md`](final-results-2026-10-21-ja.md#2026-10-22-評価器バグの訂正) と `artifacts/miracl-holdout-metric-correction-20261022.json` を参照。
