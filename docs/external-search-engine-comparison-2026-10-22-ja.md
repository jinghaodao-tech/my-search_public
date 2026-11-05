# 外部検索エンジン比較（2026-10-22）

## 結論

Meilisearch v1.55.0を隔離して起動し、JaGovFaqsRetrievalの全22,794文書と開発614クエリで実測した。Hit@10は41.4%で、同一の質問・文書・正解IDを使ったmy-search実装64.0%、独立標準BM25 72.6%を下回った。一方、Meilisearchの検索p50/p95は27/95 msだった。これは開発データの探索的なシステム比較であり、一般化や未使用holdoutの認定ではない。

MeilisearchのMIRACL全6,953,614文書評価は行っていない。10万文書の実測から得た容量・メモリ増加は、このマシンの空きRAMを超える見込みで、全件索引を開始するのは危険と判断した。SQLite FTS5標準BM25は全MIRACL索引で3クエリを実行できたが、n=3の疎通・性能観察であり品質比較ではない。TypesenseはDocker daemonが90秒以内に起動せず、WSLも`Wsl/ERROR_ACCESSDENIED`となり未実施。

## JaGovFaqs 全22,794文書・開発614クエリ

すべて同じ質問ID、正解ID、22,794文書を使った。my-search APIと標準BM25は既存の`/api/search/terms`で抽出された語を使う。Meilisearchはユーザー入力に近い原文質問を直接受け取り、標準のtokenization/ranking/typo設定を使用した。したがって、これは検索エンジンとクエリ解析を合わせたエンドツーエンド比較であり、ランキング関数だけのアブレーションではない。

| 方式 | Hit@1 | Hit@10 | MRR@10 | nDCG@10 | p50 | p95 | 検索入力・計時範囲 |
|---|---:|---:|---:|---:|---:|---:|---|
| my-search impl API | 0.414 | 0.640 | 0.492 | 0.528 | 2,037.5 ms | 2,692.2 ms | 共通パーサ＋API＋既存ランキング |
| SQLite FTS5標準BM25（形態素） | 0.435 | 0.726 | 0.521 | 0.570 | 18.46 ms | 40.60 ms | 共通パーサ＋FTS検索・ランキング |
| Meilisearch v1.55.0 | 0.207 | 0.414 | 0.268 | 0.303 | 27.02 ms | 95.21 ms | 原文質問をlocalhost検索APIへ送信 |

614件の対応比較では、my-searchがMeilisearchより成功したケース187、Meilisearchのみ成功48、両方成功206、両方失敗173。Meilisearch標準BM25との比較では標準BM25のみ成功212、Meilisearchのみ成功20、両方成功234、両方失敗148。参考として独立二項のexact McNemar p値はそれぞれ1.45e-20、1.15e-41だが、反復開発に用いた開発データの値であり、確認的な有意差主張には使わない。

Meilisearchの22,794件投入時間は16.6秒、`indexSize` 135,569,408 bytes、`usedIndexSize` 109,531,136 bytes、検索エラー0。評価前の初回ID変換ではJaGovの`benchmark-`接頭辞を正解IDへ対応させられず、全件失敗に見えた。この結果は破棄し、正規ID写像後の別インデックスで再実行したv2のみを上表に採用した。

計時範囲は一致しないため、p50/p95を厳密な速度順位とはしない。Meilisearchは検索HTTP要求、my-searchはパーサとAPI経路、標準BM25は既存ベンチマークのパーサ・FTS計測である。my-searchの現APIは全記事ロード等の処理も含む。

## MIRACL 全コーパスの実測

- MIRACL日本語6,953,614文書をFTS5形態素・N-gram両索引に取り込み、14 shardのSHA-256と各行数、最終文書数を照合済み。隔離SQLiteは42,662,330,368 bytes。
- 独立SQLite FTS5標準BM25（形態素）を全件索引で開発代表3クエリに実行。エラー0、Hit@10=1/3、Hit@100=3/3、Hit@1000=3/3、p50=20.45 s、p95=26.62 s、peak RSS=522,686,464 bytes。n=3のため、検索品質の比較値や安定レイテンシとは扱わない。
- 2026-10-22に計測器を段階別にして同じdevelopment先頭3代表を再測定。Supertestから `/api/search/terms` へ接続する方式はこの実行環境で `connect EACCES 127.0.0.1:<port>` となったため、開発診断に限りルートと同一の `purposeWords()` / `purposeTermWeight()` / `analyzeQuery()` 関数をプロセス内で呼び、同じSQLite FTS5 `bm25()` で順位付けした。エラー0、Hit@10=1/3、Hit@100=3/3、Hit@1000=3/3。全体p50=2.30 s、p95=3.20 s、検索SQL p50=1.32 s、p95=1.73 s、正解候補の追加診断SQL p50=0.97 s、p95=1.46 s、peak RSS=421,187,584 bytes、heapUsed最大=96,654,808 bytes。n=3かつ計測経路が前回と異なるため前記20.45/26.62秒と直接比較せず、安定性能やAPIレイテンシの主張には使わない。パーサ・トークン準備・正解文書lookupは今回の計時では主な遅延源ではなく、全コーパスFTSランキングと追加診断SQLの双方に時間を要した。
- 全MIRACL 6,953,614文書を検索対象とするvalidation代表581件の標準FTS5 BM25評価を完了。エラー0、Hit@1=0.198、Hit@10=0.494、Hit@100=0.773、Hit@1000=0.902、MRR@10=0.286、nDCG@10=0.270。検索SQL単体p50/p95=1.023/3.846 s、評価器全体p50/p95=1.732/6.992 s、peak RSS=478,724,096 bytes、heapUsed最大=119,477,656 bytes。評価器全体時間には正解文書取得と別のgold候補診断SQLが含まれる。API loopbackの代わりに `/api/search/terms` と同じ解析関数を直接呼んだため、実HTTP APIのレイテンシではない。これはvalidationでの基準測定であり、holdout評価や改善効果の確認ではない。
- 2026-10-22に同じ581件を使い、重み0.2を固定したタイトル再順位プロトタイプを一度実行。候補は形態素BM25 top-1000で固定し、スコアを[0,1]に正規化した後、タイトル内の解析語被覆率×0.2を加えた。Hit@10は0.494（287/581）から0.515（299/581）へ+12件/+2.07ポイント、Hit@1は0.198から0.212、MRR@10は0.286から0.301、nDCG@10は0.270から0.285。対応比較は両方成功281、基準のみ6、試作のみ18、両方失敗276。追加再順位時間はp50/p95=173/292 ms。これは既に診断・仮説形成に使ったvalidation上の探索値であり、独立評価・統計的な改善証明ではない。top-1000候補外の正解は救えず、本番ランキングにも未接続。結果JSONはローカルの `miracl-title-rerank-validation-581-exploratory.json`。
- 同じ開発3質問をN-gram FTS5 `bm25()` 単独で測定。エラー0、Hit@10=0/3、Hit@100=1/3、Hit@1000=2/3、検索SQL p50/p95=54.31/103.73 s、評価器全体p50/p95=60.96/116.53 s、peak RSS=420,311,040 bytes。n=3のため品質比較には使わないが、validation 581件へ単純外挿すると検索SQLだけで約8.7時間となる。短いbigramが大きな一致集合を生み、順位付けが高コストになることを示す探索的な性能観察であり、全件N-gram品質評価は実施しない。
- 同じ581件の診断では、解析語のすべてが正解文書群のどこかに一致する質問が337件（そのうちHit@10=213）、一部一致が234件（Hit@10=74）、一致語なしが10件（Hit@10=0）。形態素FTSの一致候補に正解が1件以上含まれた質問は569/581（97.9%）、正解がFTS候補にない質問は12件。正解候補は存在するがtop-1000に入らなかった質問が45件あり、残る57件のtop-1000失敗のうち大半は語彙候補取得後の順位改善余地にある。ただし、これは開発ではなくvalidationを見た診断値なので、以後の調整には使わず探索用に格下げする。
- my-searchのFTS5-RRF実API用3クエリ診断は、件数診断と全順位RRFを含む最初の実行が長時間無出力だったため中断。全コーパスRRFの品質・速度結果は未取得である。これは結果0ではない。
- 2026-10-22、HTTP loopbackを避けて同じ `searchArticleIdsFts5Rrf()` を直接呼ぶ3クエリ開発スモークも試したが、約4分で1件目が終わらず中断。出力結果なし、品質値なし。これは全一致順位を2トークン方式で計算する現行RRF retrievalの全コーパスコストが非常に高い可能性を示すが、完了したタイミング測定ではない。
- Meilisearchの最初の10,000件スモークは投入11.0 s、`usedIndexSize` 66,437,120 bytes。次の100,000件の規模測定は136 s、`indexSize` 1,191,170,048 bytes、`usedIndexSize` 493,395,968 bytes、Meilisearch process working set 1,512,730,624 bytes、peak working set 3,181,502,464 bytes（Windows計測値）。
- 10万件測定を全6,953,614件へ単純比例した参考値は、索引約83 GB、working set約105 GB、peak working set約221 GB、投入約2.6時間となる。これは先頭10万件のみからの外挿であり、実測・保証値ではない。OS報告の空きRAMは約37 GBだったため、全件Meili索引は開始しなかった。

部分MIRACLインデックスの検索でgold記事が無いケースは品質0として扱わない。10k/100kのMeilisearch結果は容量・APIスモーク専用で、ランキング品質スコアには含めない。

## タイトル・固有名詞・タグの想起

- JaGovFaqsの22,794文書はタイトル0件、タグあり0件。従ってJaGov比較はタイトル・タグを覚えた検索の評価ではない。
- MIRACL validationではKuromojiの固有名詞品詞細分類と、解析語の正解title/body一致を機械的に集計した。title overlapは497/581でHit@10=257/497（51.7%）、title一致なしで本文に一致する群は74件・30/74（40.5%）、解析語が正解文書群に一致しない群は10件・0/10。クエリにKuromoji固有名詞が1つ以上あるものは328件、その固有名詞のいずれかが正解title/bodyに一致するものは321件で、Hit@10は166/328（50.6%）。これらは文書とクエリの文字列・品詞proxyで、本人が語を覚えて検索したかは観測していない。層別はvalidationを使ったため探索的で、事後条件付きの結果として扱う。
- MIRACLにユーザータグはなく、タグ記憶条件は測定不能。JaGovFaqsもタイトル・タグが空のため、Meilisearchを含むエンジン比較で記憶したtitle/tag語を評価できない。
- MeilisearchをMIRACL全件へ索引化できていないため、Meilisearchのtitle-overlap/proper-noun-overlap層別結果は未取得。タグ想起を測るには、タグが実在する記事と参加者の自然検索語・後日確定した正解を同意の下で収集する必要がある。

## 他エンジンと制約

- Typesense v30.2: 公式Dockerイメージを使う計画だったが、Docker Desktopを起動してもDocker Engine named pipeが90秒以内に現れなかった。代替のWSL起動はアクセス拒否。索引化・検索とも未実施で、スコアはない。
- Meilisearch v1.55.0公式Windows binaryは352,880,640 bytes。公式GitHub Release APIのdigest `948535579776ea8aeeffd166ac824f26624468b4f82d6e46a613230d8c91e62a` と実ファイルのSHA-256一致を確認。ローカル隔離起動時はanonymous telemetryを無効化。
- 追加の外部サービス、Embedding、外部APIは使用していない。日本語はMeilisearchの標準言語処理、Typesenseは公式資料上Docker等のself-host構成を確認したが、実機評価とは分ける。

### 追加候補の探索

- OpenSearch 3.9.0を次の独立候補として選定した。公式Windows ZIPはJDK同梱でDockerなしでも起動でき、Lucene系BM25とKuromoji analyzerを持つため、Meilisearchとは別の検索基盤・日本語解析を試せる。公式手順ではWindows archiveの取得・展開で起動でき、Kuromoji analyzerは日本語形態素解析の例を提供している（[OpenSearch Windows install](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/windows/)、[Kuromoji analyzer](https://docs.opensearch.org/latest/analyzers/language-analyzers/kuromoji/)、[BM25 keyword search](https://docs.opensearch.org/latest/search-plugins/keyword-search/)）。
- 実行は未着手。シェルから公式artifact hostへのHEAD要求がDNS失敗し、配布物を取得できなかった。ホストにはJavaもなく、Docker Engineも利用不可。ネットワーク取得が可能になれば、まずJaGovFaqs 22,794件で隔離評価し、既定Kuromoji/BM25のまま開発614クエリを比較する候補とする。OpenSearchの結果をMeilisearchやMIRACLの結果で代用しない。
- TantivyはRust製の別検索ライブラリで、disk-backed indexやtop-K検索のアルゴリズム比較候補として有望。ただしこの環境のCargo cacheにcrateがなく、ここでは製品HTTPエンジンではなく専用の再現可能な比較ハーネス構築が必要なため、今回の実機比較には含めていない（[Tantivy benchmark design](https://tantivy-search.github.io/bench/)）。

## 再現ファイル

- `quality/japanese-human-retrieval-datasets/benchmark_meilisearch.ts`: 隔離SQLiteからのMeilisearch一括投入と開発評価。MIRACL IDやJaGov IDの検索用符号化は可逆で、qrelsそのものは変更しない。
- `local_article_corpus/japanese-human-retrieval/jagov-meili-development-v2.json`: JaGov Meilisearch 614件結果。
- `local_article_corpus/japanese-human-retrieval/miracl-meili-scale-100k.json`: MIRACL 100k規模測定。
- `local_article_corpus/japanese-human-retrieval/miracl-full-standard-fts-smoke-3.json`: 全MIRACL索引に対する標準FTS5 3件スモーク。
- 全JSONL、SQLite、Meilisearch index、binary、ログはローカル評価領域に保持し、gitへ追加していない。

## 未実施

- MIRACL全件でのMeilisearch品質評価とMeilisearchのtitle/proper-noun想起proxy比較。
- Typesense実機評価。
- 全MIRACL validation代表の各検索方式評価、未使用holdoutの一回評価。
- MIRACL validation 581件での独立Meilisearch/OpenSearch/Typesense全件比較。現時点ではMeilisearch全件が資源上危険、TypesenseはDocker/WSL不可、OpenSearchは配布物ホストDNS不可のため未測定。
- タグ記憶を含む実利用者検索実験。現在の公開ベンチマークだけでは測れない。
