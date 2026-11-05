# 日本語検索評価の途中結果（2026-10-21）

## 評価条件

- JaGovFaqsRetrievalの全文書22,794件、開発クエリ614件。
- 正解対象を共有するクエリは同じ分割に保持。この開発分割は614対象クラスタ。
- 文書は提供された回答本文。空のタイトルに文書IDや質問文を補完していない。
- 隔離DB: `local_article_corpus/japanese-human-retrieval/jagov-verified-db/cards.sqlite`。
- 現行方式はUIと同じ `/api/search/terms` → `/api/cards/search` を実行。
- 標準BM25は同じ形態素トークンキャッシュとクエリ解析を使用。k1=1.2、b=0.75。
- 標準BM25と現行方式の差には、トークン信号、k1/b、独自補正などが含まれる。この比較だけで特定の補正が原因とは断定しない。
- すべて開発評価。最終ホールドアウトによる認定ではない。
- 対応関係全2,048件を照合。質問全文が対応回答中に部分文字列として現れるものは0件。全文一致検査だけでは質問由来の言い回しや語彙の共有を排除できない。
- 22,794件すべてのタイトルは空。質問2,048件と正解文書2,048件は一対一で、共有正解はない。

## 開発結果

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 現行API（impl） | 0.4137 | 0.6401（393/614） | 0.4920 | 0.5282 | 2037.5 ms | 2692.2 ms |
| 標準BM25・形態素 | 0.4349 | 0.7264（446/614） | 0.5207 | 0.5698 | 18.44 ms | 40.60 ms |

現行APIの時間は解析・HTTP・DB読込・ランキング等を含む。標準BM25の時間はコーパスを準備した後のクエリ解析・ランキングのみで、直接の速度優劣には使わない。現行APIのエラーは0/614。

標準BM25のHit@100は0.8664、Hit@1000は0.9397。現行APIのTop100/1000との同条件比較は未完了。

対応のあるHit@10差は+0.0863。改善67件、悪化14件。対象クラスタのブートストラップ95%区間は[+0.0586, +0.1156]。正解対象の重複がない当該分割の厳密McNemar両側p値は1.889e-9。開発分割上の探索結果であり、独立最終評価の結果として扱わない。

## 確認できた問題

1. 空タイトルを文書IDで埋める旧シーダーは数字の検索語を混入させる。修正前の結果は比較基準から除外した。
2. 一部のカードのトークンキャッシュ修復で全カードと関連データを保存し直していた。キャッシュが欠けたカードのキャッシュ列だけを更新するよう修正し、無関係なカードが更新されない回帰テストを追加。
3. 現行APIの成功群の解析語と正解本文の一致率は79.7%、失敗群は43.9%。語彙不一致との関連がある。FAQの回答には質問の主題語が省略される場合があり、情報不足とランキングの問題を追加で切り分ける。
4. 現行APIで614件中472件が10件未満の結果しか返していない。そのうち失敗145件の中で54件は標準BM25ならTop10に入る。固定スコア閾値による候補の除外を追加診断する。

## 固定開発100クエリの補正比較

同じ100対象クラスタを `jagov-mode-selection-v1` の固定ハッシュで抽出した。コーパスは引き続き22,794文書すべてを使用。スコア除外閾値はすべて0.5。

| 条件 | Hit@1 | Hit@10 | 改善/悪化（対現行） | API p50 | API p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 現行impl | 0.46 | 0.69 | — | 2774.4 ms | 3275.0 ms |
| 共起補正なし | 0.20 | 0.22 | 0/47 | 2785.7 ms | 3312.9 ms |
| 形態素解析のみ | 0.42 | 0.64 | 1/6 | 2745.7 ms | 3295.2 ms |

共起補正なしは採用しない。なお補正を外すと絶対スコアも下がり、固定閾値で除外されやすくなる。この差を共起補正の純粋なランキング効果とは解釈しない。形態素解析のみも当該API条件では改善せず、採用しない（厳密McNemar両側p=0.125）。

除外閾値0・返却上限500の診断も完了した。同じ100クエリでHit@1=0.46、Hit@10=0.72、MRR@10=0.5421、nDCG@10=0.5848。現行比で改善3件、悪化0件、厳密McNemar両側p=0.25。小さい改善のため、現段階で製品設定の変更は採用しない。返却上限も診断のため50から500に増やしているので、応答時間の単純比較はしない。

正解はTop100に82件、Top500に86件。14件は500件の窓で順位を確認できていない。候補生成されなかったと断定せず、候補総数等と併せて追加分析する。Top1000は当該APIで観測できない。

## 重複排除による正解文書の脱落と修正

前回の `development-no-dedup-diagnostic-100.json` は `dedupThreshold=0` で測っていたため、「重複排除なし」の結果ではない。実装は `threshold >= 1` のときだけ重複排除を迂回し、0は類似度0以上の候補ペアを検査する。したがって同ファイルとそこから作った比較は、重複排除なしの証拠として無効とする。ベンチマークの引数説明と出力メタデータを修正した。

100件のうちTop500外だった14件を同一コーパス・同一解析語・同じ `runPipeline` で再評価。重複排除閾値0.8では外れていた8件が、閾値1（重複排除を無効化）でTop500内へ戻った。2件はTop10、3件はTop100に入った。残る6件はTop1000でも未確認で、原因を重複排除に帰属できない。

代表例 `qid=1531` の正解 `6236` は「購入した材料」に関する回答で、誤って代表として残された `6232` は「自社で内製した材料」に関する別回答だった。本文の5文字shingle Jaccardは0.86765で、共通の定型文が類似度を押し上げていた。閾値0.8では正解カードが削除され、重複排除なしでは順位1位になった。これは同一記事の重複ではなく、意味の異なる保存対象を落とす誤統合である。

100クエリ全体の正しい比較（`archiveScoreThreshold=0`、Top500、他条件固定）はHit@10が72/100から74/100。改善2、悪化0、厳密McNemar両側p=0.5。これは開発用100件の直接 `runPipeline` 比較であり、HTTP実測ではなく、改善の統計的有意性も確認できない。順位結果を見て実装を調整した探索結果として扱う。

修正として、保存カード検索APIは呼び出し側が閾値を指定しない場合に限り重複排除を無効化する。検索画面の既定値と閾値未保存の検索設定も1.0にし、重複排除を明示的に選んだ設定（1.0未満）は引き続き尊重する。収集記事の重複排除ロジック自体は変更しない。

回帰テストでは、上記の異なるFAQカード2件が既定検索で両方残り、閾値0.8を明示すると1件にまとまることを確認した。`tests/cards.test.ts` は24/24成功、`npm run typecheck` も成功。

実APIでも隔離DBに対して確認した。`qid=1531` は閾値指定なしの `/api/cards/search` で正解 `6236` が1位、`qid=1658` は正解 `3836` が3位。両方とも全22,794文書を入力し、応答の `afterDedup` も22,794だった。

当該100クエリの現行MRR@10=0.5380、nDCG@10=0.5750。共起補正なしはMRR@10=0.2100、nDCG@10=0.2126。形態素解析のみはMRR@10=0.5016、nDCG@10=0.5358。

モード選定では同一100クエリ・同一コーパスで `impl` 69%、`theory` 72%、`trend` 71% Hit@10。`impl` 対 `theory` の改善4・悪化1、厳密McNemar p=0.375。`impl` 対 `trend` は改善3・悪化1、p=0.625。差は小さく、100件でモードの優越性は確認できない。用途適合性からFAQ質問応答では `theory` を次の検証候補とするが、未使用の検証分割で判断する。

`trend` のAPI時間はp50 2584.6 ms、p95 3273.2 ms。APIサーバーの1秒間隔サンプルは653件、観測最大RSS 2,123,722,752 bytes（約1.98 GiB）、Node heapUsed 1,594,151,736 bytes（約1.48 GiB）。測定したのはプロセスのサンプル最大であり、benchmark全体のメモリ値ではない。

既存の100クエリ成果物には旧評価スクリプトの `diagnostic_only: false` が残る。すべて開発用の部分抽出・診断であり、最終評価ではない。スクリプトは部分抽出・診断指定でも `diagnostic_only: true` と記録するよう修正済み。元の測定結果は書き換えていない。

## MIRACL 全文コーパス検索（全件DB完成・評価進行中）

- 実UI相当の収集記事検索経路は `/api/search/terms` → `/api/run`。1万文書の隔離パイロットを`fts5-rrf`で実行し、20件の開発クエリで検索経路・候補数・処理時間・RSSを記録した。初期shardだけの部分コーパスなので、Hit@10=1/20は品質評価として扱わない。
- パイロットでは形態素解析結果が空でN-gramだけ検索可能な日本語文書が1件あった。旧索引完全性判定は一方のトークン方式が空なだけでFTS全体を無効化し、全件BM25へフォールバックしていた。両方式とも空の行だけを未索引として扱うよう修正。
- FTS候補取得後にも`getCandidates()`が全記事の本文を配列化していた。FTS使用時は取得候補IDだけ候補状態を読むよう変更し、すでにFTSで適用済みのstatus/source/sinceフィルターを重ねて全件走査しないようにした。
- RRFのNode.js側全順位保持を減らす目的で各モード先頭160件だけ取る方式を試作したが、実SQLiteで全順位Top50と異なる例が出たため撤回した。順位tailを切ると厳密なRRFではない。
- 代替として、SQLite内で両FTSモードの完全な`ROW_NUMBER()`順位を算出し、完全な順位列からRRFを計算した後にだけTop-Kを返す経路を`fts5-rrf`に接続した。300文書の隔離テストで、全順位をNodeで融合したTop50とID・RRFスコアが一致し、候補総数も一致。API側も同点時にSQLの決定的な順序を維持する。API経路を含むFTSテスト6/6、typecheck成功。これは意味上の一致確認であり、全MIRACL規模の速度・メモリ測定ではない。
- 旧1万件部分コーパスDBで開発クエリ3件の実APIスモークを再実行し、APIエラー0、Hit@10は0/3。正解文書は部分コーパスに含まれないため、Hit値は品質結果ではない。観測API p50 419.5ms / p95 1349.8ms、プロセスRSS最大約478.3MiB、Node heap最大約160.5MiB。3件の疎通測定にすぎず、全コーパス性能の代表値ではない。
- 全件順位を正確に計算するSQL内fusionの性能と精度は、全MIRACL DB完成後に開発・検証データで再測定する。
- `articleSearchIndexStatus()`は記事数・両FTS行数・未索引件数を毎リクエスト全走査していたため、プロセス内キャッシュを追加し、記事のupsert/deleteと検索時トークン修復で無効化する。プロセス起動後の初回だけ全件確認する。FTS5-RRFの全コーパス検索性能測定はまだ実施していない。
- 追加調査で、`collector_service`生成時に`loadArticles()`が全記事・本文を無条件にRAMへ読み込む別経路を発見。通常起動は記事一覧を遅延ロードし、明示的な`GET /api/articles`要求時にだけ読み込むよう変更。サイト同期後は記事全件を再ロードせずキャッシュ無効化する。`GET /api/collect/scheduler/status` は集計値からlastFetchedAtを保つ。トークナイザー変更時の既存再構築動作は維持。
- FTSが拾う未知日本語bigramが再ランキング用query tokenに入らず0点になる経路も確認。形態素解析が空の場合に限り、文書側と同じ日本語文字bigramをBM25 query/group/weightへ加える。形態素解析済み語と長いカタカナ語の既存query解析は維持。
- 同じ1万文書・20開発クエリの以前の診断値は修正後p50 354.7ms、p95 428.9ms、修正前p50 747.4ms、p95 960.1ms。旧プローブの時間はUI APIに加えて診断用FTS件数照会を含み、RSSもプロセス終了時スナップショットであってピークではないため、UIレイテンシ/ピークRAM比較としては無効。現プローブは2つのUI API時間と診断処理を分離し、累積peak RSSを記録するよう修正。全コーパスで再測定する。
- 先のRRF切り詰め試作を含むパイロット計測成果物 `miracl-pilot-10k-api-20-rrf-bound.json` と `miracl-pilot-10k-api-1-rrf-bound-metrics.json` は、ランキングが不正確な試作コードでの測定なので、検索品質・現行実装の性能比較には使わない。エラー0などの疎通記録に限って参照できる。全順位を正確に計算する現行コードで再計測が必要。
- 全件用の`import_miracl_full_fts.ts`は14 shardのSHA-256、各shardの行数、総記事数、2つのFTS行数、source行数を検証し、ステージングDB検証後に確定した。2026-10-22に6,953,614文書すべての投入を完了。各テーブル/FTS行数は6,953,614、隔離SQLiteは42,662,330,368 bytes。原本14 shardのhashと行数もmanifestに一致。
- `evaluate_miracl_standard_fts.ts`は全件MIRACL索引に対してSQLite FTS5組み込み`bm25()`のtop-1000を取得する。validation代表581件を全6,953,614文書で評価し、エラー0、Hit@10=0.494、Hit@100=0.773、Hit@1000=0.902、MRR@10=0.286、nDCG@10=0.270。検索SQL p50/p95=1.023/3.846秒、評価器全体p50/p95=1.732/6.992秒、peak RSS=478,724,096 bytes。APIループバックは実行環境のEACCESで使えず、同じquery-analysis関数をin-processで呼んだためHTTPレイテンシではない。探索済みvalidationの基準値であり、最終holdoutや改善効果の判定ではない。過去の3件評価は計測方式が違うためこの数値と単純比較しない。
- 全581件を用いた事後診断では、形態素FTS候補にgoldがある質問569件、候補にgoldがない質問12件。候補ありでもtop-1000外は45件。解析語がgold文書群に全一致する337件のHit@10は213、部分一致234件では74、語彙一致なし10件では0。さらにタイトル一致proxy 497件のHit@10は257（51.7%）、本文のみ一致74件では30（40.5%）。Kuromoji固有名詞を含む質問328件、その語がgold title/bodyに一致するもの321件・Hit@10 166（328件中のHit@10=50.6%）。これは利用者が語を記憶していたかの測定ではない。validationを見た事後層別のため探索用であり、この分割は以後の独立確認に再使用しない。MIRACLとJaGovFaqsにユーザータグはなくタグ想起は未測定。
- 固定重み0.2のタイトル再順位プロトタイプを同じvalidation 581件で完走。Hit@10は287/581から299/581（+12件、+2.07ポイント）、MRR@10は0.286から0.301、nDCG@10は0.270から0.285。対応比較で基準のみ成功6、試作のみ成功18。追加再順位時間はp50/p95=173/292 ms。validationは既に探索に使ったため、この結果は確認的・独立な改善証拠ではない。`ARTICLE_SEARCH_ENGINE=fts5-title-rerank` のopt-in API経路は後続で実装したが、既定ランキングは変更していない。出力はignored local artifact `local_article_corpus/japanese-human-retrieval/miracl-title-rerank-validation-581-exploratory.json`。
- MIRACL開発3件でN-gram FTS5標準BM25を単独実行。Hit@10=0/3、検索SQL p50/p95=54.31/103.73秒、評価器全体p50/p95=60.96/116.53秒、RSS約420MB。n=3は品質根拠ではない。validation 581件の全件実行は単純な中央値外挿でも検索SQL約8.7時間となるため行わない。短いbigram一致集合の大きさと順位計算がコスト要因と考えられる。
- Meilisearch v1.55.0を別エンジン比較に追加。JaGovFaqs全22,794文書・開発614クエリでHit@10=0.414、MRR@10=0.268、nDCG@10=0.303、検索p50/p95=27/95 ms。部分MIRACL 100kの実測は136 s、Meili peak working set約3.18 GB。全件外挿は参考値に限る。全MIRACLのMeili索引は行っていない。TypesenseはDocker Engine起動不可、WSLアクセス拒否により未実施。詳細は[`docs/external-search-engine-comparison-2026-10-22-ja.md`](../../docs/external-search-engine-comparison-2026-10-22-ja.md)。

## 2026-10-22 実API再順位の原因分析とTop-K最適化

- 同じMIRACL開発代表100クエリ・全6,953,614文書で、直接の形態素FTS5 BM25はHit@10=51/100。一方、以前のopt-in API経路はTop1000候補に対して`runPipeline`で候補集合内のコーパス統計を再計算し、Hit@10=24/100まで低下していた。Top10の平均重複は3.5/10、APIのみ成功3件・直接FTSのみ成功30件。原因は正解候補の生成ではなく、全コーパスBM25順位を候補部分集合の別BM25で上書きする再順位処理にあると判断。
- `fts5-title-rerank` のopt-in経路を修正し、全コーパスSQLite `bm25()` の順位・スコアを基準にしてタイトル一致信号だけを加えるよう変更。重み0では、同じ100クエリの実API結果が直接FTSと一致してHit@10=51/100、MRR@10=0.2776、nDCG@10=0.2619。重み0.2ではHit@10=53/100、MRR@10=0.3032、nDCG@10=0.2799。対応差は改善2・悪化0・双方成功51・双方失敗47。重みは開発データ上で先に探索されており、これは同じ開発系列の探索値で、有意性や独立改善を主張しない。既定検索エンジンには昇格していない。
- 重み0/0.2のAPI比較は同一プロセス内で各クエリの実行順を交替。APIエラー0。重み0のp50/p95=1,983/6,496 ms、重み0.2は2,027/6,005 ms。peak RSS=593,154,048 bytes、heapUsed=147,309,512 bytes。処理時間の差をタイトル補正の速度効果とは解釈しない。
- 旧Top-K候補SQLの遅延要因も分離。6.95M DB・同一クエリのwarm/cold交互計測4回中央値は、FTS単独Top1000=3,493 ms、記事テーブルJOINと`candidate_status!='expired'`条件付きTop1000=9,366 ms。全6,953,614件が`unreviewed`である隔離MIRACL DBでは、FTS上位Kを取得してからIDをバッチで状態確認するfast pathへ変更。期限切れが上位Kを押し出した場合は窓を拡張して補充する。旧/新SQLのTop1000全配列一致を小規模テストで確認し、expiry除外後も正しい次順位を返す回帰テストを追加。
- `tests/article-search-fts.test.ts` 9/9、`npm run typecheck`成功。全件DBでのAPIスモークは1件、重み0.2でHit@10、約4.5秒。これは疎通のみ。100件API比較のp95は約6秒で、実用性に改善余地が残る。
- 新しい対応API実験器`probe_miracl_title_weight_pairs.ts`は開発代表から重複なしで選択し、両重みを交互に評価する。結果はignored local artifacts `miracl-api-development-100-title-weight-paired-v2.json` と `miracl-api-development-100-title-weight-paired.json` に保存。
- MIRACL validationはすでに複数の診断と方式探索に使われたため探索データ扱いを維持する。MIRACL holdoutは未読。95%主張のための方式・コード指紋・設定固定、独立評価は未完了。測定クエリもWiki passage retrievalであり、保存記事の実利用再発見には一般化しない。
- `probe_miracl_fts.ts`を実UIの50件返却上限に合わせ、Top1/10/50、MRR@10、nDCG@10、エラー、候補数・一致数・レイテンシを記録するよう拡張。実API起動と標準比較でテスト用localhost TCPが環境に拒否されたため、承認された隔離ローカル接続で起動した。パイロットDBで3件を実行しエラー0、部分コーパスのため0/3 hit。3件は疎通確認のみで品質・速度主張には使わない。
- 遅延記事ロード修正後、隔離パイロットのAPIを再起動。起動ログに全件記事ロードは現れず、3件のAPI呼び出しはエラー0。これは起動/疎通確認のみで品質評価に含めない。
- 代表選定/統計判定に `select_cluster_representatives.mjs` と `evaluate_representative_gate.mjs` を追加。出力・代表選択は結果非依存hash、1クラスタ1件を強制し、片側97.5% Clopper–Pearson下限、H0上側p値、標準BM25との対応McNemar・cluster bootstrapを出力する。合成フィクスチャのNode test 4/4、702/726境界テスト成功。
- 付属比較器のNode移植`compare_miracl_results.mjs`を追加し、結果ID・正解ラベル・クラスタ一致を確認してからクラスタ単位bootstrapと対応Hit@10差を出す。パイロット3件の比較CLI疎通成功。7件のNode統計/CLIテストが成功し、繰返しクラスタがある場合McNemarを不適用にすること、ラベル・クラスタ変更を拒否することを確認。
- MIRACLのholdoutは未参照・未実行。全件DB完成後にdevelopment→validationで方式を選び、コード・検索設定・統計計画を固定してから一度だけ使う。

## 検証済み

- `npm run typecheck`: MIRACL標準BM25比較とAPI評価器を含め再成功。
- `npm exec vitest -- run tests/article-search-fts.test.ts tests/bm25.test.ts tests/miracl_json_stream.test.ts --reporter=verbose`: 15/15成功。FTSの片側トークン索引、索引更新/削除、全件候補を誤ってロードしない経路、日本語bigram-only文書、MIRACL内の生改行JSONを確認。
- `node --test quality/japanese-human-retrieval-datasets/japanese-human-retrieval-datasets/test_representative_evaluation.mjs quality/japanese-human-retrieval-datasets/test_compare_miracl_results.mjs`: 7/7成功。代表選択の決定性、各クラスタ1件、702/726の正確下限境界、対応比較、重複クラスタ拒否、CLI経路、cluster bootstrap、qrels/cluster改変拒否を合成フィクスチャで確認。
- `tests/collector-review.test.ts`と`tests/article-search-fts.test.ts`: 遅延ロード版の収集キャッシュ、`GET /api/articles`互換性、FTS回帰を合わせて19/19成功。初回はtest DBの既存fixture件数を誤って1固定して失敗したため、件数固定を除き実在データ取得を検証するテストへ修正。
- 索引状態キャッシュと全順位保持版の `tests/article-search-fts.test.ts`: 6/6成功（2026-10-21最終再実行）。300文書のSQLite FTSで完全な両モード順位を取得すること、RRF試作の不一致を検出して撤回した現行全順位経路、日本語bigram-only、索引更新/削除、API経路とキャッシュ無効化を確認。`npm run typecheck`も撤回後に成功。Vitest APIテストにはlocalhost接続権限が必要。

MIRACL holdoutの統計計画は [`miracl-holdout-preregistration-2026-10-21-ja.md`](miracl-holdout-preregistration-2026-10-21-ja.md) に固定した。752質問/726の正解共有クラスタから、結果非依存hashで各クラスタ1件を選ぶ主評価は726件。片側α=.025、H0:p≤.95に対し最低702成功（最大24失敗）が必要で、独立cluster representative仮定下の真のp=.98で検定力0.99286。holdout自体は未読・未実行で、検索設定とコードfingerprintはvalidation完了後、holdoutを開く前に追記して固定する。
- `git diff --check`: エラーなし（既存ファイルの改行に関する警告あり）。
- `tests/cards.test.ts`: 23/23成功（前の実行で確認）。
- 対応比較ツールの単体試験: 3/3成功。ラベル変更の拒否、共有クラスタ時の独立検定抑止、厳密検定の既知例を確認。
- データ準備・比較ツールの単体試験合計: 6/6成功。
- APIベンチマークの複数正解nDCG、重複文書、API失敗に関する試験: 3/3成功。
- APIプロセスの1秒サンプリングはtrend 100件評価で記録出力を確認。実プロセスの役割判定を厳密化したため、新しいサンプルで件数を再検証する。

## 未完了

- 診断結果の候補生成・語彙一致・順位補正への原因分解、検索モードの比較。
- モード選択、検証分割、コードと統計計画の固定、未使用ホールドアウトの一回評価。
- MIRACL日本語の全件RRF/rerank実API評価、別エンジンのvalidation全件比較、未使用holdoutの一回評価。標準FTS5 BM25、評価専用のタイトル再順位プロトタイプ、title/proper-noun proxy層別はvalidation 581件で完了したが、いずれも探索済みデータであり確認的な結果ではない。全順位RRF直接スモークは4分で1件目から進まず中断、結果なし。
- MeilisearchのMIRACL全件評価、Typesense実機評価、title/proper-noun想起proxy比較。Meili全件は10万件の資源測定から現PCでは危険と判断し未実施。タグと利用者の実記憶は公開ベンチマークでは測定不能。
- メモリの方式別比較と詳細な失敗原因の分類。
- JaGovFaqsはFAQの質問と回答の対応であり、保存記事の実利用検索記録ではない。実利用95%を認定する材料として無条件に一般化しない。

## ローカル成果物

- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-impl.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-standard-morph-bm25.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-standard-paired.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-ablation-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-no-archive-diagnostic-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-no-archive-paired-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-dedup-ablation-corrected-100.json`（direct pipeline・開発探索）
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-theory-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-trend-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-theory-paired-100.json`
- `local_article_corpus/japanese-human-retrieval/jagov-verified-db/development-trend-paired-100.json`

元のユーザーカード・メモ・Readerデータの変更、commit、pushは行っていない。
