# my-search FTS5統合・リポジトリ実行検証（2026-10-23）

## 実施範囲

添付仕様に基づく既存実装のリポジトリ内検証。対象は保存カード検索、既存FTS5派生索引、TOMT Movies開発データ上の標準形態素BM25比較。カード・メモ・Readerの本番データは変更していない。Movies隔離DBはread-onlyで開いた。比較結果を見て本番既定ランキングを変更していない。

## 実行した比較

### 独自BM25 対 標準BM25

Movies開発分割の8,845文書から、既使用先頭502対象群を除外し、SHA-256群順のoffset 502から500群を固定。各群1クエリを別の固定ハッシュ順で選択した。評価選択はquery/qrel/rankを見ずに行った。評価結果は開発分割内の探索比較であり、独立コーパス評価ではない。

| 方式 | Hit@1 | Hit@10 | Hit@100 | Hit@1000 | MRR@10 |
|---|---:|---:|---:|---:|---:|
| 現行 `runPipeline`（impl） | 58/500 | 126/500 (25.2%) | 222/500 | 348/500 | 0.1568 |
| 独立標準形態素BM25（k1=1.2,b=0.75） | 58/500 | 127/500 (25.4%) | 210/500 | 338/500 | 0.1550 |

現行と標準のHit@10差は **−0.2ポイント**、対象群対応bootstrap 95%区間 **−2.2〜+1.8ポイント**。discordant groupsは現行のみ成功12、標準のみ成功13、exact two-sided McNemar p=1.00。MRR@10差は+0.0018、bootstrap 95%区間−0.0114〜+0.0153。優位性は示されなかった。候補未生成は現行0/500だが、Top10未達は374/500であり、主な残余問題はこの測定条件下での順位上げである。

診断器は当初ソース全件を再トークン化していたため、同じ隔離DBの永続トークン列をread-onlyで再利用するオプションを追加した。DB内8,845 IDとJSONL文書IDの完全一致に加え、全カードのタイトルと本文もJSONL原本と完全一致することを実行時に検証する。全500件の本測定では、検索方式ごとの順位計算・標準比較・結果生成を含む平均診断時間は2,015.72ms/query。これは単一検索要求のAPIレイテンシではない。

### [訂正対象] FTS5 RRF・固定タイトル信号（旧測定は無効）

> **訂正:** この節のタイトル専用FTSスコアは、`bm25(cards_fts, ...)` の列重みを4個しか渡しておらず、意図した `title` ではなく既定重みが `tags` に適用されていた。以下に残る旧数値は再現履歴として保持するが、方式選択・優位性の根拠としては無効。旧しきい値スイープも同じ理由で無効。正しい列順 `id,title,body,summary,tags` での再測定とraw-only比較を、本書末尾の追補に記録する。関連成果物は削除せず、無効データとして保管する。

別のMovies開発対象群500件（SHA-256群順offset 1002）を固定し、係数0.1だけで一度評価した。重み0.1は既使用開発標本の探索で選択済みであるため、本結果は群分離した開発確認ではあるが、独立な最終確認ではない。

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 |
|---|---:|---:|---:|---:|
| 標準形態素BM25 | 57/500 | 116/500 (23.2%) | 0.1507 | 0.1702 |
| 形態素/N-gram/raw FTS5の等重みRRF | 65/500 | 126/500 (25.2%) | 0.1629 | 0.1838 |
| 上記RRF + タイトル専用FTS信号（RRF重み0.1） | 64/500 | 128/500 (25.6%) | 0.1625 | 0.1845 |

タイトルRRF対標準BM25のHit@10差は+2.4ポイント、対象群bootstrap 95%区間+1.0〜+4.0ポイント。これは固定された当該開発標本での比較で、同一ソース分割への一般化に限界がある。タイトル信号を基礎RRFに加えた直接差は+0.4ポイント（2群の改善、0群の悪化、126群同率）で、上積みは小さい。タイトルRRFのレイテンシ欄は複数FTSリスト、標準BM25、候補バリアントを同時に算出する比較ハーネスのp50=351.557ms、p95=564.277msであり、製品APIの単独レイテンシではない。RSS=694,939,648 bytes、heapUsed=276,630,064 bytesも同プロセスの測定終了時点で、ピーク・方式別増分ではない。

**結論:** 固定タイトル信号付きFTS5-RRFはこのMovies開発標本では標準BM25を上回ったが、現行FTS5-RRFからの増分はわずか。効果を独立データで確認できておらず、既定方式への昇格・係数の再調整・本番ランキング変更はしない。既存のFTS5経路は任意の比較対象として保持する。

### 追加の未使用開発群での再現性確認

offset 1502の別500群では標準BM25 116/500、基礎FTS5-RRF 109/500、固定タイトルRRF 110/500となり、タイトルRRF対標準の差は−1.2ポイント（group bootstrap 95%区間−2.6〜+0.2ポイント）だった。offset 1002では+2.4ポイント、offset 1502では−1.2ポイントと符号が反転した。

両群を単純合算した1,000群では、標準BM25 232/1,000、基礎FTS5-RRF 235/1,000、タイトルRRF 238/1,000。固定タイトルRRF対標準の差は+0.6ポイント、対応group bootstrap 95%区間−0.5〜+1.7ポイント。基礎RRFとの差は+0.3ポイント（2群改善、0群悪化）だが、係数は既使用標本から選択されており、この区間を独立な確証とは解釈しない。

探索診断ではクエリ解析後の平均語数が49.12語。正解タイトルにNFKC小文字化した解析語の文字列部分一致が1語以上ある群346件と、一致がない654件に分けても、タイトルRRF対標準のHit@10差はいずれも+3件だった。部分一致の有無だけでは標本間の効果反転を説明できなかった。これは診断目的の文字列照合で、言語学的な語境界・関連性判定ではない。

## 全リポジトリ検証の状態

この実行系列で直近に実施済みの `npm run verify` の各段階では、typecheck、frontend build/check、basic tests（38 pass）、acceptance（47 files、367 pass、1 skip、0 fail）、Playwright Chromium E2E（12 pass）、synthetic benchmark、HTTP benchmark、検索品質評価、verification artifact/encoding/OpenAPI/schema/search-index checksが通過した。実RSS再生1件は `RSS_REGRESSION_FEED_FILE` 未指定のためskip。検索品質fixtureは ranking 20件 P@1=0.90、endToEnd 20件 P@1=0.95、real 50件 P@1=0.84・qualityGate=trueであり、実利用自然クエリの独立検証ではない。

一方、集約コマンド `npm run verify` は `npm audit` の7件（moderate 4、high 2、critical 1）で非成功となり後続へ進まなかった。Docker Desktopが利用できずDocker buildは未確認。したがって「verify全体成功」とは報告しない。作業ツリー・隔離DB・本番データは保持し、commit/pushはしていない。

## 再現コマンド

```powershell
npm.cmd run typecheck
node_modules\.bin\tsx.cmd quality\e2e\tools\diagnose_ranking.ts quality\e2e\data\reddit_tomt\movies development quality\e2e\artifacts\movies-dev-current-vs-standard-fresh500-20261023.json 500 phase3-current-vs-standard current --mode-id=impl --group-offset=502 --database=data\movies-dev-bm25-vs-rrf-20261022.sqlite
node_modules\.bin\tsx.cmd quality\e2e\tools\summarize_ranking_comparison.ts quality\e2e\artifacts\movies-dev-current-vs-standard-fresh500-20261023.json quality\e2e\artifacts\movies-dev-current-vs-standard-fresh500-summary-20261023.json
node_modules\.bin\tsx.cmd scripts\bench\benchmark_tomt_title_rrf.ts quality\e2e\data\reddit_tomt\movies data\movies-dev-bm25-vs-rrf-20261022.sqlite quality\e2e\artifacts\movies-dev-title-rrf-fixed-0_1-offset1002-500-20261023.json --offset=1002 --groups=500 --weight=0.1
```

## 成果物と限界

- `quality/e2e/artifacts/movies-dev-current-vs-standard-fresh500-20261023.json`: 500群の個別ランキング診断。データ本文を含むため評価用ローカル成果物。
- `quality/e2e/artifacts/movies-dev-current-vs-standard-fresh500-summary-20261023.json`: 対応差・bootstrap区間・McNemar検定。
- `quality/e2e/artifacts/movies-dev-title-rrf-fixed-0_1-offset1002-500-20261023.json`: 固定タイトルRRF比較・各クエリ結果・時間/RAM。
- 検証対象群はMovies開発分割であり、Movies validation/holdoutは過去の計画・実行で消費済みのため使用していない。未使用の独立最終データでの認定は `NOT_EVALUABLE`。
- 実利用者の自然検索・保存カード再発見率、95%成功率、数万件規模の性能、コールド/ウォーム本番API p95、方式ごとのピークRSS/索引容量はこの比較からは判定できない。

## 追補: 重み付け訂正・raw-only再比較・保存カードUI統合（2026-10-23）

### 訂正した評価条件

FTS5は `cards_fts(id UNINDEXED,title,body,summary,tags)` の5列。タイトル専用比較の正しい指定は `bm25(cards_fts,0.0,1.0,0.0,0.0,0.0)`。修正前の4重み指定はタイトル専用ではなかったため、旧タイトル信号の比較・しきい値探索結果を無効とする。固定方式の係数選択に誤評価を使った可能性がある比較は採用根拠にしない。

### 固定3標本・2,000対象群の探索比較

開発コーパスSHA-256 `99cafecf4432dfe6c5677774cf92cbce9b9ab570823edfe39454718c2b91296a`、Movies development、offset 3502（500群）・4002（500群）・4502（1,000群）の互いに重複しない計2,000 target group。各groupから1クエリを固定ハッシュで選択し、検索語解析・文書集合・qrelsを共有。対象群を対応単位として20,000回bootstrapした。既使用Books/Moviesのvalidation・holdoutではなく、Movies development内の探索結果である。

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | Hit@10差 vs 標準 (paired bootstrap 95% CI) |
|---|---:|---:|---:|---:|---:|
| 独立標準形態素BM25 (k1=1.2,b=.75) | 245/2,000 | 522/2,000 (26.10%) | 0.16283 | 0.18613 | 基準 |
| FTS5 morphology-only | 258/2,000 | 540/2,000 (27.00%) | 0.16901 | 0.19295 | +0.90pp [+0.30,+1.55]pp |
| **FTS5 raw-only BM25** | 253/2,000 | **543/2,000 (27.15%)** | 0.16752 | 0.19211 | **+1.05pp [+0.40,+1.70]pp** |
| FTS5 morphology + raw RRF | 255/2,000 | 541/2,000 (27.05%) | 0.16838 | 0.19257 | +0.95pp [+0.35,+1.55]pp |
| FTS5 morphology + n-gram + raw RRF | 243/2,000 | 514/2,000 (25.70%) | 0.16063 | 0.18346 | -0.40pp [-1.25,+0.45]pp |

raw-only対標準はHit@10の対応標本bootstrap区間が0を上回った一方、これは単一のTOMT Movies開発分割内での探索的証拠であり、独立コーパスへの一般化・実保存記事の再発見率・95%絶対達成を示さない。最終評価は `NOT_EVALUABLE`。all-three等重みRRFはこの2,000群で標準を上回らず、N-gram信号を含めれば必ず改善するという仮説は支持されなかった。

### API/UIでの実装と検証

比較結果を本番既定へ昇格させず、`CARD_SEARCH_ENGINE=fts5-raw` を実験用・明示選択として追加。保存カード画面は従来どおり `/api/cards/search` を呼び、応答 `scope.searchMethod` とスコア詳細からraw-only方式を確認できる。raw FTS候補が0件となる日本語クエリでは既存の形態素+N-gram+raw RRFへフォールバックし、`fallbackUsed` と `fts5-raw-fallback-rrf-saved-cards` で明示する。実行中の日本語E2Eでこのtokenizer差が検出され、フォールバック追加後に再実行した。

- `npm run typecheck`: pass。
- `vitest run tests/config.test.ts tests/cards.test.ts tests/article-search-fts.test.ts --fileParallelism=false`: 3 files / 40 tests pass。初回サンドボックス実行はlocalhost権限で接続失敗したが、許可環境の再実行は全件pass。
- Chromium `e2e/core-flows.spec.ts` を `E2E_CARD_SEARCH_ENGINE=fts5-raw` と `fts5-morph` で各実行、各10/10 pass。raw-only英語経路・日本語fallback、形態素-onlyの日本語経路を確認。
- 保存カードテストはtest DB、Playwrightは `quality/e2e/artifacts/e2e-fts5-raw-isolated.sqlite` を使用。本番DBには接続していない。

raw-onlyモードは候補比較用で、既定 `like` と従来の `fts5` 等重みRRFの設定を変更していない。raw-onlyは通常のSQLite `unicode61` tokenizerを使うため、日本語では候補0件時にfallbackする。これは精度性能を日本語へ一般化できないことを示す。次は日本語の未使用検索データで独立比較し、また候補0件以外の日本語漏れも調べる。

## 追補: Books別ドメイン再検証と実API評価（2026-10-23）

### 独立ランキング比較（Books development全1,528 target groups）

Moviesとは別のTOMT Books development、1,910文書・1,528 target groups。Moviesと同じSQLベンチマークで標準形態素BM25（k1=1.2,b=.75）およびFTS信号を比較。Booksでは過去のBooks validation/holdoutは使わずdevelopmentのみ使用した。各groupから1質問を選択。Moviesと同じタスク系列内の別カテゴリであり、完全に独立したデータ源とは見なさない。

| 方式 | Hit@10 | 差 vs 標準 (target-group bootstrap 95% CI) | MRR@10差 (95% CI) | nDCG@10差 (95% CI) |
|---|---:|---:|---:|---:|
| 標準形態素BM25 | 566/1,528 (37.04%) | 基準 | 基準 | 基準 |
| FTS5 morphology-only | 574/1,528 (37.57%) | +0.52pp [+0.13,+0.98]pp | +0.00228 [-0.00134,+0.00603] | +0.00290 [-0.00027,+0.00621] |
| FTS5 raw-only | 570/1,528 (37.30%) | +0.26pp [-0.20,+0.72]pp | +0.00434 [+0.00108,+0.00770] | +0.00392 [+0.00098,+0.00698] |

Movies developmentではmorphology-onlyのHit@10が標準BM25より+0.90pp [ +0.30,+1.55 ]pp、raw-onlyは+1.05pp [ +0.40,+1.70 ]ppだった。したがって純ランキング比較では形態素-onlyが2カテゴリでHit@10優位を示すが、双方とも同一TOMT由来のdevelopmentデータであり、最終・独立評価とはしない。

### 実際の保存カードAPI経路（Books development全1,528群）

追加比較スクリプトは実際の `/api/search/terms` と `/api/cards/search` を呼び、固定ハッシュで各target groupから1クエリを選択。候補検索・ルートの結果整形・既存BM25補正を含む。ここでのBM25は**現行アプリのBM25構成**であり、前項の「独立標準BM25」とは異なる。

| API方式 | Hit@10 | MRR@10 | nDCG@10 | p50 / p95 (ms) | エラー |
|---|---:|---:|---:|---:|---:|
| 現行アプリBM25 | 612/1,528 (40.05%) | 0.25991 | 0.29326 | 148.7 / 236.8 | 0 |
| 形態素 + N-gram + rawの等重みRRF | 573/1,528 (37.50%) | 0.23678 | 0.26928 | 60.0 / 109.9 | 0 |
| raw-only FTS5 | 570/1,528 (37.30%) | 0.24251 | 0.27340 | 28.4 / 56.2 | 0 |
| morphology-only FTS5 | 574/1,528 (37.57%) | 0.24045 | 0.27239 | 28.8 / 55.1 | 0 |

target-group bootstrapで現行BM25に対するHit@10差はRRF -2.55pp [-3.80,-1.37]pp、raw-only -2.75pp [-4.06,-1.44]pp、morphology-only -2.49pp [-3.73,-1.24]pp。全FTS方式でレイテンシは改善したが、現行アプリ方式より品質を落とした。ゆえに**いずれも既定方式に採用しない**。SQLでの独立標準BM25比較でmorphology-onlyが優位だったことを、現行アプリ全体への優位性と読み替えてはならない。

RSS 1,035,055,104 bytes、heapUsed 367,249,544 bytesはベンチマークプロセス終了時の全方式合計値で、各方式のピーク・増分ではない。隔離Books DBは9,097,216 bytes。API p50/p95はこのローカルプロセスでの測定で、他環境への性能保証ではない。

この比較から得られた次の改善課題は、**FTS5を最終ランキングに直結させるのではなく、候補生成段階だけに使い、現行BM25で再順位付けした場合の品質・候補再現率・速度を同一API経路で測ること**。まだ実装・評価しておらず、現段階の結果は「FTS-only置換は速度向上と引き換えに品質低下」という反証である。

### 候補生成としてのFTS5再現率診断

上記Books developmentの同じ1,528 target groupと1,910文書を用い、FTS5を候補生成のみに使う場合の候補数と正解文書包含率を追加測定した。固定ハッシュで選んだ各クエリについて、FTS候補集合に含まれるqrel正解文書の割合を計算した。これは候補生成の診断であり、再順位付け後の検索品質・速度測定ではない。

| 候補方式 | 平均候補数 | 候補数中央値 | p95候補数 | 正解文書包含率 | 全正解を含むクエリ |
|---|---:|---:|---:|---:|---:|
| morphology FTS5 | 1,264.6 / 1,910 | 1,300 | 1,740 | 94.37% | 1,442 / 1,528 |
| raw FTS5 | 1,254.2 / 1,910 | 1,289 | 1,716 | 94.31% | 1,441 / 1,528 |
| morphology + raw union | 1,264.6 / 1,910 | 1,300 | 1,740 | 94.37% | 1,442 / 1,528 |

候補集合は平均して全コーパスの約66%にとどまる一方、正解を含まないクエリが約5.6%残る。候補生成だけで速度を稼げる余地はあるが、現状のFTS5候補集合をそのまま最終候補とする方式は、この欠落を回復できない。FTS候補の後に現行BM25で再順位付けする方式はまだ未実装・未測定であり、採否を決めない。成果物: `quality/e2e/artifacts/books-dev-candidate-recall-full1528-20261023.json`。

## 追補: 標準BM25とFTS5の固定順位融合（開発探索）

標準BM25単独と、標準BM25順位にFTS5順位をRRF（k=60、等重み、係数調整なし）で加えた方式を比較した。Moviesは過去の標本と重ならないdevelopmentの固定ハッシュ順offset 5,502から1,500 target group、Booksは既存のdevelopment全1,528 groupを用いた。Books標本は新しい方式の初回比較ではあるが、同一クエリ集合を他方式の探索で既に使用しているため独立な確認標本ではない。両コーパスとも同じTOMT由来であり、一般化の証拠にはしない。

| データ | 方式 | Hit@10差（対応bootstrap 95% CI） | MRR@10差（95% CI） | nDCG@10差（95% CI） |
|---|---|---:|---:|---:|
| Movies development 1,500群 | FTS5 morphology-only | +1.47pp [+0.80,+2.20] | -0.00095 [-0.00521,+0.00322] | +0.00262 [-0.00127,+0.00653] |
| Movies development 1,500群 | 標準BM25 + morphology/raw FTS5 RRF | +0.87pp [+0.40,+1.40] | +0.00106 [-0.00185,+0.00392] | +0.00286 [+0.00022,+0.00549] |
| Books development 1,528群 | FTS5 morphology-only | +0.52pp [+0.13,+0.98] | +0.00228 [-0.00137,+0.00596] | +0.00290 [-0.00025,+0.00619] |
| Books development 1,528群 | 標準BM25 + morphology/raw FTS5 RRF | +0.20pp [-0.07,+0.52] | +0.00297 [+0.00108,+0.00514] | +0.00271 [+0.00105,+0.00458] |

観察: morphology-only FTS5は3つのTOMT開発標本（Movies 2,000群、Movies新規1,500群、Books 1,528群）すべてでHit@10差の95%対応bootstrap区間が正側だった。一方、新規Movies標本ではMRR・nDCGの区間がゼロを含む。標準BM25+morphology/raw RRFはMovies新規標本でHit@10・nDCGが正側、BooksではMRR・nDCGが正側だがHit@10区間はゼロを含む。したがって改善の方向は有望でも、全指標・カテゴリで一貫した優位とはまだ言えない。各群1クエリのペアbootstrapであり、同一ソース内の探索的区間である。

実際の保存カードAPI比較では、現行アプリBM25のHit@10 40.05%に対し、FTS5各モードは37.30〜37.57%だった。ここで試した標準BM25+FTS5 RRFはオフライン開発ベンチマークであり、現行アプリAPIへ導入・評価していない。標準方式に対する開発データの改善を、製品既定検索の改善と混同しない。最終・独立評価と既定方式の変更は引き続き保留する。

成果物:
- `quality/e2e/artifacts/movies-dev-standard-fts-rrf-offset5502-1500-20261023.json`
- `quality/e2e/artifacts/movies-dev-standard-fts-rrf-offset5502-1500-summary-20261023.json`
- `quality/e2e/artifacts/books-dev-standard-fts-rrf-full1528-20261023.json`
- `quality/e2e/artifacts/books-dev-standard-fts-rrf-full1528-summary-20261023.json`

## 追補: BEIRでの厳密トークン一致再測定（2026-10-23）

標準BM25と形態素FTS5の比較で、形態素トークン文字列をFTS5 `unicode61` が再分割し得る点を発見した。そこで比較用スクリプト `scripts/bench/benchmark_beir_standard_fts.ts` を修正し、各Kuromoji形態素をUTF-8の16進表現に可逆符号化してFTS5へ渡すことで、1形態素=1 FTS語を保証した。標準BM25と形態素FTS5は同一のKuromoji文書・クエリトークン列を使う。raw FTSは別トークナイザーによるエンドツーエンド比較として分離する。これは評価コードのみの変更で、本番ランキング・DBは変更していない。

| データ / 方式 | Hit@10 | 差 vs 標準BM25 (cluster bootstrap 95% CI) | MRR@10 | nDCG@10 | MAP@100 |
|---|---:|---:|---:|---:|---:|
| ArguAna 標準BM25 | 984/1,406 (69.99%) | 基準 | 0.21448 | 0.33060 | 0.22654 |
| ArguAna FTS5 morphology-only | 982/1,406 (69.84%) | -0.14pp [-0.64,+0.36] | 0.21428 | 0.33015 | 0.22655 |
| ArguAna FTS5 raw-only | 988/1,406 (70.27%) | +0.28pp [-0.36,+1.00] | 0.21663 | 0.33305 | 0.22876 |
| ArguAna standard+morph FTS RRF | 987/1,406 (70.20%) | +0.21pp [-0.14,+0.57] | 0.21473 | 0.33127 | 0.22666 |
| NFCorpus 標準BM25 | 218/323 (67.49%) | 基準 | 0.52156 | 0.31202 | 0.14002 |
| NFCorpus FTS5 morphology-only | 217/323 (67.18%) | -0.31pp [-0.31,0.00] | 0.52004 | 0.31147 | 0.13987 |
| NFCorpus FTS5 raw-only | 222/323 (68.73%) | +1.24pp [0.00,+1.25] | 0.51775 | 0.30838 | 0.13728 |
| NFCorpus standard+morph FTS RRF | 217/323 (67.18%) | -0.31pp [-0.31,0.00] | 0.52162 | 0.31141 | 0.14001 |

ArguAnaは各クエリが独立した正解文書クラスタ1,406個を形成するが、正解文書5件は公式コーパスに存在しないため、全方式で取得不能として保持した。FTS形態素単独とRRFのHit@10区間はいずれも0を跨ぐ。raw-onlyはHit@10差が小さく区間も0を含み、MRR/MAPの小幅差はあるものの、一貫した優位とは判定しない。

同一のKuromojiトークン列を与えた標準BM25とmorphology FTS5でも、Top10はArguAna 1,406件中792件、NFCorpus 323件中97件で異なった。これは同一トークン入力のもとでBM25 IDF・長さ正規化・tie-break等の順位式が異なるためであり、FTS5が精度を上げた証拠ではない。比較は「トークン列を固定したスコア実装差」として解釈する。

NFCorpusは323クエリに対して正解文書が12,334件ある一方、正解クエリ・文書の二部グラフはわずか6連結クラスタ。通常のクエリ独立bootstrapは不適切で、クラスタ数6のbootstrap区間も推定が粗い。raw-onlyのHit@10増加はnDCG/MRR/MAPの低下と併存するため、改善の証拠として扱わない。両コーパスとも同一qrelsを過去に使った再測定であり、独立ホールドアウトではない。

| データ | 文書 | クエリ | 形態素索引構築時間 | 1クエリ全方式 p50/p95 | 実行終盤RSS / heapUsed |
|---|---:|---:|---:|---:|---:|
| ArguAna | 8,674 | 1,406 | 120.5秒 | 162.8 / 248.9 ms | 960 MB / 298 MB |
| NFCorpus | 3,633 | 323 | 96.7秒 | 2.3 / 18.2 ms | 766 MB / 217 MB |

レイテンシは各クエリで標準BM25・形態素FTS・raw FTS・RRFをすべて計算した合計時間で、エンジン単独のp50/p95ではない。RSS/heapUsedは方式別増分ではなくベンチマークプロセス全体の値。インデックス容量の比較は未測定。コーパスSHA-256等は各JSON成果物に記録した。

## 追補: 作業ツリーのFTS5統合を再実行検証（2026-10-23）

### テスト

- `npm.cmd run typecheck`: PASS。
- 全Vitest `npx.cmd vitest run tests --pool=threads --fileParallelism=false`: 47 files / 371 passed / 1 skipped / 0 failed。
- 初回のsandbox内Vitest実行はlocalhost socketの`EACCES`で失敗した。localhostを許可した再実行は、FTS・保存カードAPI・migration・静的回帰の4 files / 57 testsすべてPASS。別にBM25単体9 testsもPASS。
- Playwright `e2e/core-flows.spec.ts e2e/refind-study.spec.ts`: Chromium 11/11 PASS。専用の新規SQLiteを指定し、保存カード検索UIからFTS5-RRFのAPI応答まで確認。
- `git diff --check`: whitespace errorなし。既存ファイルのCRLF→LFに関するGit警告のみ。

### 実際の保存カードAPI比較

`scripts/benchmark_saved_card_search_fts.ts`を実行。隔離DBへ匿名トークンコーパスを登録し、30個の手書き関連度付きクエリを共通の`/api/search/terms`解析後、実際の`POST /api/cards/search`へBM25とFTS5-RRFの両方で送信した。APIエラーは両方式0件。

| 方式 | Hit@1 | Hit@10 | R-Precision | MRR@10 | Recall@5 | nDCG@5 | API p50/p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| BM25 | 0.700 | 0.900 | 0.6944 | 0.7733 | 0.8889 | 0.7924 | 26.38 / 41.43 ms |
| FTS5-RRF | 0.700 | 0.933 | 0.6944 | 0.7803 | 0.8889 | 0.7947 | 13.51 / 25.88 ms |

Hit@10はFTS5-RRFのみ成功1、BM25のみ成功0、同値29。30件の同一開発セットでの小差であり、信頼区間・独立評価ではない。データは匿名化トークンfixtureで、本文そのものではない。process終端RSS 554,426,368 bytes / heapUsed 185,671,152 bytesは両方式を実行したプロセス全体であり、方式ごとの増分ではない。

比較DB `data/cards-fts5-verification-20261023.sqlite` と結果 `artifacts/saved-card-fts5-validation-20261023.json` を新規作成した。実行後に`data/cards.db`は5,652,480 bytes、更新時刻は当日00:36のままで、13時台のベンチ実行では変更されていない。同名出力を使った再実行は拒否され、隔離DBのSHA-256が拒否前後で不変であることも確認した。

### 再現コマンドと成果物

```powershell
npm.cmd run typecheck
npx.cmd vitest run tests --pool=threads --fileParallelism=false
npx.cmd playwright test e2e/core-flows.spec.ts e2e/refind-study.spec.ts
npx.cmd tsx scripts/benchmark_saved_card_search_fts.ts data/cards-fts5-verification-20261023.sqlite artifacts/saved-card-fts5-validation-20261023.json
npx.cmd tsx scripts/bench/evaluate_bm25_ablation.ts jagov-dev 614 --data-dir quality/e2e/artifacts/jagov-development --output quality/e2e/artifacts/jagov-a8-transfer.json --variants A8-no-context-no-coverage,S3-standard-morph-k1.2-b0.75 --skip-reference --compact
npx.cmd tsx scripts/bench/paired_bm25_bootstrap.ts quality/e2e/artifacts/jagov-a8-transfer.json quality/e2e/artifacts/jagov-development/jagov-dev.eval.json quality/e2e/artifacts/jagov-a8-transfer-bootstrap.json
```

JAGOV転移診断の詳細は`BM25-JAGOV-ABLATION-TRANSFER-RESULTS-2026-10-23-ja.md`、BM25方式全体の累計判定は`BM25-STANDARD-SUPERIORITY-REVIEW-2026-10-23-ja.md`を参照する。

### 完了判定の境界

FTS5の実装経路・既存テスト・ブラウザUI連携は今回の実行で確認した。一方、30件API比較とJAGOV developmentは探索用であり、使用済みholdoutを新しい独立評価には転用していない。実保存カードの自然検索セッションは0件なので、利用者95%成功率と独立した最終統計判定は `NOT_EVALUABLE`。小/中/大コーパスを通したcold/warm HTTP p95、FTS索引サイズ、再構築・更新失敗の運用測定もこの実行では完了していない。本番ランキングの既定値、カード・メモ・Readerのレコードは変更していない。commit/pushなし。

実行結果は、FTS5が標準BM25を一貫して上回るとの仮説を支持しない。ArguAnaのわずかな指標差は確定的でなく、NFCorpusでは関連クラスタの少なさと指標間のトレードオフが残る。現行APIでのFTS-only品質低下も既測定であるため、本番既定を変えない。次に必要なのは未使用の独立クエリ群と、保存カードAPIにおける候補生成+現行BM25再順位付けの実測である。

再現コマンド（元ZIPは維持し、抽出済みコピーのみ使用）:

```powershell
npm.cmd run typecheck
node_modules\.bin\tsx.cmd scripts\bench\benchmark_beir_standard_fts.ts data\ir_benchmark\work\beir-arguana-extracted\arguana quality\e2e\artifacts\beir-arguana-standard-fts-exact-token-20261023.json
node_modules\.bin\tsx.cmd scripts\bench\benchmark_beir_standard_fts.ts data\ir_benchmark\work\beir-nfcorpus-extracted\nfcorpus quality\e2e\artifacts\beir-nfcorpus-standard-fts-exact-token-20261023.json
```

成果物:
- `quality/e2e/artifacts/beir-arguana-standard-fts-exact-token-20261023.json`
- `quality/e2e/artifacts/beir-nfcorpus-standard-fts-exact-token-20261023.json`

### リポジトリ回帰実行

- `npm.cmd run typecheck`: pass。
- 保存カード・記事FTS・設定・migration・tokenizer・静的回帰の6ファイル: 66/66 pass。
- 基本API・query parser: 3ファイル、38/38 pass。
- `e2e/core-flows.spec.ts` raw FTS: 10/10 pass。
- `e2e/core-flows.spec.ts` morphology FTS: 10/10 pass。
- `git diff --check`: pass（既存CRLFファイルのLF正規化警告のみ）。

Vitest/Playwrightのlocalhost利用はsandboxで拒否された初回があったため、承認されたlocalhost実行で再試行してpassを確認した。`npm run verify` 全体は実行していない。既存の追跡済みテスト結果JSONを上書きせず、同コマンドに含まれる全Acceptance・全E2E・全ベンチマーク・npm audit・Docker buildもこの追補では再実行していない。FTS/E2E/HTTP評価と修正後のVitestは隔離DBを使用した。初回全Vitestにおける本番DBのjobテスト行については、下記の訂正を参照。commit/pushなし。

### テストDB安全性の訂正

2026-10-23の初回全Vitest実行後に`data/cards.db`の更新時刻が動いたため調査したところ、`tests/job_service.test.ts`だけが共通`tests/helpers.ts`を読み込まず、DB_PATH未指定で本番既定DBを開く構成だった。初回実行はjobsテーブルへテスト用4行（queued/running 2行、成功/失敗2行）を書き込んでいた。queued/runningは同テストの起動処理でテスト文言付きfailed状態になった。

ID・type・created_atが一致するこの4行だけを1トランザクションで削除した。条件が4行すべてに一致しなければ中断する手順を使った。13:18 UTCの更新時間帯には他のjob更新がなく、現在の読み取り専用検査は cards=234、articles=207、`PRAGMA quick_check=ok`、該当4行なし。テストファイルは先頭で`tests/helpers.ts`をimportして隔離DBを設定するよう修正し、単独3/3 pass、その後の全Vitest 371 pass/1 skip再実行後も新しい本番jobs行がないことを確認した。

初回実行前のDB全体ハッシュやスナップショットは取っていないため、DBファイル全体のバイト単位不変は証明できない。確認できた範囲では、変更はこの4つのテストjob行に限定され、削除済み。カード/記事の件数は確認前後で同じだが、全カード内容の事前比較はない。再発防止として`job_service.test.ts`を隔離DBに固定した。

## 追補: リポジトリ一連の再実行（2026-10-23）

ユーザーDBと既存の評価JSONを避け、現在のdirty worktreeで再実行した。

| 段階 | 結果 |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run check:frontend` | PASS |
| Vitest全体 `npx.cmd vitest run tests --pool=threads --fileParallelism=false` | sandbox内はlocalhost `EACCES`で95件失敗。localhost許可で再実行し **47 files / 371 passed / 1 skipped / 0 failed** |
| Playwright全spec `npx.cmd playwright test` | sandbox内で出力待ちになったため中断。新規の別DB・別ポートでlocalhost許可後 **12/12 PASS** |
| `npm.cmd run check:verification-artifacts` | PASS |
| `npm.cmd run check:encoding` | PASS |
| `npm.cmd run check:openapi` | PASS（10必須項目） |
| `npm.cmd run verify:schema` | PASS（12 tables、foreign key違反0、integrity `ok`） |
| `npm.cmd run check:search-index` | PASS（カード12件、FTS12件、欠落・孤児0） |
| `npm.cmd run check:saved-card-search-index` | PASS（形態素/N-gram/raw 各12件） |
| `npm.cmd run check:article-search-index` | PASS（記事3件、両FTS索引3件、token欠落0） |
| `npx.cmd tsc -p tsconfig.frontend.json --outDir quality/e2e/artifacts/frontend-build-20261023` | PASS。生成先を専用ディレクトリに分離 |
| `npm.cmd audit --audit-level=high` | FAIL。7件（moderate 4、high 2、critical 1）。`npm audit fix`は依存更新を伴うため、この検証作業では適用していない |
| Docker daemon確認 | 未実行。`dockerDesktopLinuxEngine` named pipeが存在せずdaemonへ接続できない |
| `git diff --check` | whitespace errorなし。CRLF→LFの既存警告のみ |

E2Eは`quality/e2e/artifacts/repo-sequence-e2e-approved-20261023.sqlite`と対応JSONへ出力した。sandbox内で中断した先行試行DBも別ファイルとして残し、再利用・削除していない。実利用DB `data/cards.db` は読み取り専用で確認し、bytes 5,652,480、mtime `2026-10-23T04:22:45.791Z`、cards 234、articles 207、`PRAGMA quick_check=ok`。テスト開始後に更新されていないことをmtimeで確認した。

`npm run verify`そのものは実行していない。同スクリプトは既存のtracked `artifacts/*.json`、`docs/benchmark.md`等を上書きする工程と、利用不可のDocker daemonを含むためである。既存の品質ベンチマーク結果は本レポート前段およびBM25レビュー文書に記録済みだが、この再実行では再生成していない。したがってテスト・静的/DB検査・E2Eは確認済み、依存監査は脆弱性のため失敗、Docker buildは未確認という範囲である。
