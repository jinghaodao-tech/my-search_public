# 保存カード検索 FTS5 統合・検証

更新日: 2026-10-22

## 目的と範囲

画面の「自分のカードから」検索が使う `POST /api/cards/search` に、SQLite FTS5の永続索引経路を追加した。従来BM25は残し、設定で切り替えられる。記事検索の `/api/run` やReader保存形式は変更していない。

## 実装

- Migration `025_create_saved_card_token_fts` が、保存済み形態素トークンとN-gramトークンのFTS5索引を作成する。既存の `cards_fts` はタイトル・本文・概要・タグの生テキスト索引として維持する。
- 保存カード検索は形態素・N-gram・生テキストの各FTS順位をRRF (`k=60`) で統合する。SQLで順位付けして上位IDだけを取得し、本文などのカード詳細はそのID分だけ読む。
- カード作成・更新・削除とトークンキャッシュ更新はSQLite triggerで派生索引へ反映される。タグ・概要を含む既存の生テキスト索引も併用する。
- FTS5が選択され、3索引テーブルが存在する場合にFTS経路を使う。それ以外は既存BM25へフォールバックする。カード件数とFTS件数の全件比較は検索ごとには行わず、明示的なhealth checkで検証する。カード変更とFTS更新はSQLite triggerで反映される。類似カードの重複排除は従来どおり既定で無効。明示的に重複排除を指定した検索も互換のためBM25へフォールバックする。
- 切替は `CARD_SEARCH_ENGINE=fts5`。既定値は既存設定の `like` のままで、今回の探索的スコアだけを根拠に全利用者の既定を変更していない。
- 索引確認: `DB_PATH=<sqlite> npm run check:saved-card-search-index`
- 索引再構築: `DB_PATH=<sqlite> CARD_SEARCH_INDEX_REBUILD_CONFIRM=REBUILD_DERIVED_INDEX npm run rebuild:saved-card-search-index`。再構築は検索トークンキャッシュとFTS派生索引のみを更新する。

## 実測比較

`data/search-evaluation/anonymized-corpus.json` の匿名化トークン233文書と `real-queries-v2.json` の手書き30クエリを、隔離SQLiteへ投入した。両方式とも `POST /api/search/terms` の同じクエリ解析結果を使い、実際の `POST /api/cards/search` を実行した。これは本文のないトークン由来フィクスチャであり、実本文検索や独立ホールドアウトの評価ではない。

| 指標 | 従来BM25 | FTS5/RRF |
|---|---:|---:|
| Hit@1 | 0.700 | 0.700 |
| Hit@10 | 0.900 (27/30) | 0.933 (28/30) |
| R-Precision | 0.694 | 0.694 |
| MRR@10 | 0.773 | 0.780 |
| Recall@5 | 0.889 | 0.889 |
| nDCG@5 | 0.792 | 0.795 |
| API p50 | 35.6 ms | 16.9 ms |
| API p95 | 51.7 ms | 27.1 ms |
| 返却件数中央値 | 16 | 16 |

対応比較ではHit@10改善1件、悪化0件、同率29件。30クエリだけの探索評価なので、有意な汎化改善とは主張しない。プロセス終端RSSは571 MB、heapUsedは199 MBだが、両方式を同じNodeプロセスで実行した全体値であり方式別増分ではない。

## 保存カード経路監査

- 変更前から画面は `/api/cards/search` を利用していたが、APIは全カードを読み込みBM25へ渡していた。現在は `CARD_SEARCH_ENGINE=fts5` のとき同API内でFTS5/RRFへ切り替わる。
- Playwright Chromiumで画面から検索し、レスポンスの `scope.searchMethod` が `fts5-rrf-saved-cards` であることを検証した。
- カードCRUD、タグ、概要検索、除外語、類似カードの既定保持、明示的重複排除の互換性をfocused Vitestで検証した。
- Readerがカード本文の上限を超えて保持する `reader_texts` の残り全文は、この索引対象ではない。現状の保存カード検索と同じくカード本文として保存された範囲が対象となる。全文Reader検索を追加する場合は別の索引更新契約が必要。

## MIRACL Hit@10 / Hit@50の監査

2026-10-22のMIRACL holdout runnerに**評価器バグ**があった。`hitMetrics()` はTop50の最初の正解順位を求めた後、`first >= 0` をHit@10としていたため、11〜50位の正解もHit@10に加算していた。同じ誤りで、11〜50位の逆順位もMRR@10へ加算していた。Hit@50自体はAPI応答上位50件を対象にしている。

保存済み726行のTop10 IDだけからHit@10・MRR@10・nDCG@10を再計算した。Top50全IDと応答件数は保存されていないため、11〜50位の正解ID・実返却件数は再構成できない。保存済みHit@50は元runnerのTop50照合フラグとしてのみ報告する。

| 指標 | 形態素FTS5 BM25 | title coverage 0.2 |
|---|---:|---:|
| Hit@1 | 139/726 | 139/726 |
| **修正後Hit@10（保存Top10から再計算）** | **337/726 (46.42%)** | **352/726 (48.48%)** |
| 保存済みHit@50（Top50照合フラグ） | 495/726 (68.18%) | 515/726 (70.94%) |
| 修正後MRR@10（Top10から再計算） | 0.2710 | 0.2770 |
| nDCG@10（Top10から再計算） | 0.2509 | 0.2586 |
| 保存Hit@10との不一致 | 158/726 | 163/726 |

正しいHit@10では両方式ともHit@50より低く、Hit@10=Hit@50という現象は実データ上の順位分布ではなく評価器バグによるものだった。修正後Top10による対応表は baselineのみ3、candidateのみ18、両方成功334、両方失敗371（差+15/726、+2.07ポイント）。参考のexact McNemar両側p値は0.00149だが、これは消費済みholdoutの事後的な指標修正値であり、独立評価・再認定として扱わない。以前のHit@10、MRR@10、Clopper–Pearson下限、対応比較・信頼区間は無効。以前のAPIレイテンシ計測値自体は検索実行時間の記録として残るが、品質値と一体の性能主張には再利用しない。

回帰として、11位の正解がHit@10/MRR@10に入らずHit@50には入るケースを追加した。API返却件数とTop11〜50の直接再監査は、726×2回の固定条件API再生が `API ready` ログ到達前に進まず中断したため未完了。独立評価は `NOT_EVALUABLE`。この消費済みholdoutを再調整や新規認定に使わない。

## 検証結果

- `npm.cmd run typecheck`: pass
- `npx.cmd vitest run tests/cards.test.ts tests/miracl_metrics.test.ts --reporter=default`: 27/27 pass（通常sandboxではVitest一時renameがEPERM。承認付き実行で確認）
- Chromium Playwright `runs BM25 search from the browser UI`: pass。実際のAPI応答で `scope.searchMethod=fts5-rrf-saved-cards` を確認
- Chromium Playwright `keeps distinct FAQ cards in saved-card search unless deduplication is selected`: pass
- `npm.cmd run build`: pass、95 files built
- benchmark: 30クエリ、両方式APIエラー0
- 索引確認: 233 cards / morphology 233 / n-gram 233 / raw FTS 233、pass
- 隔離DBの索引再構築: token cache 233件更新、FTS 233件、health check ready
- `git diff --check`: pass（既存dirtyファイルのCRLF/LF警告のみ）
- MIRACL checkpoint監査: 保存Hit@10との不一致158/163件を検出し、Top10から再計算。API再生は未完了
- Playwright再実行: sandboxではサーバーready前に停止したが、承認付き実行で対象2ケースpass
- FTS5品質比較: 30クエリ、両方式APIエラー0

## 評価の適用範囲・反復

- 保存カード検索の実装反復は、FTS候補検索＋形態素/N-gram/生テキストのRRFを1方式として導入し、既存BM25との同一API比較を行った。30件の開発クエリ上はHit@10が27/30から28/30へ変化、1件改善・0件悪化・29件同率。独立した検証データがないため、これ以上の係数・ランキング反復は行わず、実装を任意設定に留めた。
- ミニコーパスは匿名化トークン233文書で、本文全文、数千〜数万件、Reader別テーブルの長文、自然利用クエリを代表しない。開発比較から「検索品質が安定して優位」とは結論しない。
- 標準BM25、Fts5標準rank、既存方式、今回のRRFは30件の同一API条件で比較した範囲に限る。MIRACLの旧比較値はHit@10/MRR評価器バグの影響があるため、標準BM25等との正確な再比較値として採用しない。
- 消費済みMIRACL holdoutの修正済み要約は監査であり、独立統計評価は `NOT_EVALUABLE`。95%成功率の判定は行っていない。
- 数千〜数万カード、コールド/ウォーム、同時実行、索引容量の本番規模評価は未測定。実利用に対する仮のp95 500ms目標も未判定。
- 結果は保存記事の実利用再発見率に一般化しない。本文全文や実利用セッションの独立データが揃うまでは、既定検索エンジンを変更しない。

## 再現コマンド

```powershell
npm.cmd run typecheck
npx.cmd vitest run tests/cards.test.ts tests/miracl_metrics.test.ts --reporter=default
npm.cmd run build
npx.cmd playwright test e2e/core-flows.spec.ts --grep 'runs BM25 search from the browser UI|keeps distinct FAQ cards in saved-card search unless deduplication is selected' --workers=1
node_modules\.bin\tsx.cmd scripts\benchmark_saved_card_search_fts.ts data\saved-card-search-fts-20261022-run2.sqlite artifacts\saved-card-search-fts-20261022-run2.json
$env:DB_PATH='data/saved-card-search-fts-20261022-run2.sqlite'; npm.cmd run check:saved-card-search-index
$env:CARD_SEARCH_INDEX_REBUILD_CONFIRM='REBUILD_DERIVED_INDEX'; npm.cmd run rebuild:saved-card-search-index
node_modules\.bin\tsx.cmd quality\japanese-human-retrieval-datasets\audit_miracl_hit10_checkpoint.ts local_article_corpus\japanese-human-retrieval\miracl-eval\miracl-holdout-api-20261022.checkpoint.jsonl artifacts\miracl-holdout-metric-correction-20261022.json
```

## 制約

この比較は匿名化トークンフィクスチャ上の開発診断であり、実保存カードの自然検索セッションや独立ホールドアウトではない。30クエリでの小幅なHit@10差だけでは既定方式を選べない。数千件規模のカードと未使用の手書き再発見クエリで、品質・p50/p95・メモリ・索引容量を再評価する必要がある。

## 大きい開発コーパスでの追加比較（2026-10-23）

以前からあるReddit-TOMT Movies開発分割のうち、Books開発結果を確認した後に固定した500対象グループを使用した。各対象から1クエリ、全8,845文書、保存カード検索API、同一隔離SQLiteで比較した。Movies validation/holdoutやMIRACL/JaGovFaqs holdoutは使用していない。この確認は別ドメインの開発データであり、未使用の最終評価・記事再発見への一般化とは扱わない。

500件のグループ抽出は `SHA-256(group_id)` 順、各群1クエリは `SHA-256(group_id + NUL + query_id)` 順。API経路の事前スモークで観測した先頭2群は本比較から除外し、offset=2で固定した。データ選定に検索順位・qrel結果は使用していない。

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | Top50候補内正解 | レイテンシp50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| 独立標準BM25（形態素、k1=1.2,b=0.75） | 52/500 | 122/500 | 0.1432 | 0.1670 | 177/500 | 41.95 / 83.27 ms* |
| 保存カードAPI既定BM25 | 57/500 | 133/500 | 0.1587 | 0.1841 | 181/500 | 2,306 / 2,679 ms |
| 保存カードAPI FTS5/RRF | 58/500 | 121/500 | 0.1508 | 0.1723 | 178/500 | 386 / 570 ms |
| 固定融合: API BM25 1 + FTS RRF 0.1 | 56/500 | 131/500 | 0.1576 | 0.1825 | Top50和集合から再順位 | オフライン融合。API値未測定 |

*標準BM25はトークンを事前ロードしたランキング処理だけであり、HTTP/API値と直接比較できない。全カード数8,845。隔離DB全体は175,869,952 bytes（カード表・FTS索引等を含み、索引単体サイズではない）。API実行後のプロセスRSSは1,829,437,440 bytes、heapUsedは677,767,808 bytes。これは同じNodeプロセスの終了時点値で、方式別増分でもピークRSSでもない。

標準BM25に対する対応Hit@10差（正解対象500群の10,000回クラスタ・ブートストラップ95%区間）:

| 方式 | 共同成功 | 標準のみ | 候補のみ | 共同失敗 | Hit@10差 | 95%区間 |
|---|---:|---:|---:|---:|---:|---:|
| API既定BM25 | 107 | 15 | 26 | 352 | +2.2ポイント | −0.4〜+4.8ポイント |
| FTS5/RRF | 111 | 11 | 10 | 368 | −0.2ポイント | −2.0〜+1.6ポイント |
| 固定融合 1:0.1 | 107 | 15 | 24 | 354 | +1.8ポイント | −0.8〜+4.2ポイント |

APIエラーは全方式0件。既定BM25はこの標本で標準BM25より点推定が高いが区間は0を含む。FTS5/RRFは既定BM25よりHit@10が12件少ない。Booksで事後探索した固定融合はMoviesで既定BM25より2件少なく（差−0.4ポイント、クラスタ区間−1.0〜0.0ポイント）、改善を示さなかった。Books上の別重みも、Hit@10差のクラスタ区間は0をまたぎ、MRRを下げる比率があった。よって現段階で、FTS5またはRRF融合を既定ランキングへ昇格させない。

### 失敗位置の診断

この500件でTop50に正解が含まれたのは既定BM25 181件、FTS5/RRF 178件だった。標準BM25ではTop10 122件、Top50 177件、Top100 209件、Top1000 331件。Top50からTop10への順位改善余地に加え、正解がTop1000外または語彙候補に届かないケースも残る。現APIのTop50外順位は未観測であり、APIについてTop100/Top1000値を推定していない。

### 実行・再現

```powershell
npm.cmd run typecheck
node_modules\.bin\tsx.cmd scripts\benchmark_tomt_saved_card_search.ts data\movies-dev-bm25-vs-rrf-20261022.sqlite quality\e2e\artifacts\movies-dev-bm25-vs-rrf-20261022.json --dataset=movies --sample-groups=500 --sample-offset=2 --reuse-isolated-db
node_modules\.bin\tsx.cmd quality\e2e\tools\standard_bm25_from_seeded_db.ts quality\e2e\data\reddit_tomt\movies quality\e2e\artifacts\movies-dev-bm25-vs-rrf-20261022.sample-manifest.json data\movies-dev-bm25-vs-rrf-20261022.sqlite quality\e2e\artifacts\movies-dev-standard-bm25-20261023.json
node_modules\.bin\tsx.cmd scripts\evaluate_preregistered_tomt_rrf.ts quality\e2e\artifacts\movies-dev-bm25-vs-rrf-20261022.json quality\e2e\artifacts\movies-dev-rrf-fixed-evaluation-20261023.json
node_modules\.bin\tsx.cmd scripts\compare_tomt_movies_engines.ts quality\e2e\artifacts\movies-dev-bm25-vs-rrf-20261022.json quality\e2e\artifacts\movies-dev-standard-bm25-20261023.json quality\e2e\artifacts\movies-dev-engine-comparison-20261023.json
```

Books開発1,842クエリ（1,528正解対象群）の事後重み探索では、BM25 692/1,842に対し重み1:0.1融合は695/1,842（+3件、+0.163ポイント）、Hit@1は双方342、MRR@10は0.241316→0.241329、nDCG@10は0.273230→0.273577だった。群クラスタ95%区間はHit@10差−0.162〜+0.490ポイントで0を含む。1:0.25では697/1,842だがMRR@10が0.240027へ下がり、群クラスタ95%区間も0をまたいだ。候補比率はBooks開発データで選択済みで、Movies評価はその設定を固定したクロスドメイン確認である。

重み付きBooks探索 `quality/e2e/artifacts/books-dev-rank-fusion-20261022.json` とMovies固定評価 `quality/e2e/artifacts/movies-dev-engine-comparison-20261023.json` は開発データの探索・クロスドメイン確認。独立な最終統計判定は `NOT_EVALUABLE` のまま。検索手法の重みは変更せず、既定検索も変更していない。
