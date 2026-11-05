# 標準BM25に対する候補方式の累計レビュー

## 結論

2026-10-24時点で**25方式系統、189の方式バリアント×データセット/分割比較**を記録。今回、標準BM25＋タイトルcoverageについて5つの重みを3開発splitで選択比較し、選んだ固定重みを既存BEIR testへ転移したほか、Webis-Touche2020 testにも固定転移した。RM3風関連性フィードバックをFiQA dev 500問とQuora devのSHA-256固定100問で比較した結果、FiQA主指標nDCG@10差は+0.00293 (95% CI [-0.00172,+0.00746])、Quoraは+0.01284 ([-0.00443,+0.03122])で、どちらも不確実。Quora p50は標準BM25の約114倍。FTS5形態素BM25はArguAnaの固定100問でnDCG差+0.00751 (CI [+0.00012,+0.01727])だったが、SciFactの別SHAブロックでは-0.00708 ([-0.01826,+0.00107])に反転。FTS5 Porterもブロック間で一貫しなかった。Query-likelihood 10設定と固定Top-100 RRF 2設定をFiQA/Quora/TREC-COVIDで評価したが、FiQAでは改善不確実、QuoraでDirichletは悪化、TREC-COVIDでは全融合候補もnDCGが低下した。標準BM25に対し、自然な保存記事再発見へ一般化する独立・安定優位はまだ確認できていない。日本語記事メタデータの自己派生クエリに限れば現行UI検索が有望だが、公開FAQ質問では標準形態素BM25が開発・holdout双方で上回った。利用者クエリによる確認が必要。本番ランキング・ユーザーDBは変更していない。

## 候補と判定

| 候補方式 | 比較範囲 | 主な結果 | 判定 |
|---|---|---|---|
| BM25 IDF式の代替 | FiQA test、TREC-COVID test | FiQAで標準よりHit@10が低下。TREC-COVIDも主指標の改善なし | 棄却 |
| 形態素FTSとのRRF | SciDocs test、Quora test | SciDocs Hit@10 +0.005だが95%区間下限は0。Quoraはほぼ同等〜微減 | 棄却 |
| BM25+ δ=1 | Books dev | Hit@10 0.34799→0.33442、差の95% CI [-0.02115,-0.00638] | 棄却 |
| パーサー語重み付きBM25 | Books dev、FiQA dev、SciFact train | 微小な指標改善は一貫せず、未使用分割でnDCG/MRRは微減 | 棄却 |
| k1/bグリッド・固定転移 | Books dev、NFCorpus/ArguAna/SciFact test | Booksで選んだ1.2/1.0はNFCorpus nDCG@10 -0.00270、ArguAna +0.02666（95% CI [+0.02282,+0.03061]）、SciFact +0.00242（CI [-0.00494,+0.00957]）。ドメイン間で効果の方向・大きさが不一致 | 単一固定値として棄却。コーパス適応の仮説は要追加検証 |
| BM25Fタイトル重み | Books/Movies dev、固定候補のNFCorpus/ArguAna/SciFact test、日本語記事metadata dev/validation | nDCG@10差はBooks +0.00376、Movies +0.00056、NFCorpus -0.00054、ArguAna +0.00153、SciFact +0.00243。日本語記事では−0.07306/−0.07657（両区間が負） | 棄却。固定タイトル重みはドメイン転移せず、日本語記事分割では大幅悪化 |
| BM25L δ=0.5 | Books dev全1,528 groups、Movies dev固定SHA 1,500 groups | nDCG@10差Books -0.02174、Movies -0.05437。両区間が負 | 棄却 |
| 日本語A8混合方式の転移 | JAGOV official FAQ development 614問＋validation 410問、各22,794文書 | 標準形態素BM25はA8に対しdevelopment nDCG@10 +0.02910 (95% CI [+0.01495,+0.04355])、validation +0.02730 (CI [+0.01018,+0.04477])。MIRACLでのA8優位と逆転 | A8の日本語一般化は棄却。validationも多方式探索後の転移診断で、独立した最終認定には使わない |
| BM25-adpt適応型TF | NFCorpus dev、Quora dev | NFCorpusはHit@10 +0.0031とnDCG@10 -0.0052で指標混在。Quora 5,000 devクエリでは完全方式のHit@10 -0.0292 (95% CI [-0.0352,-0.0232])、nDCG@10 -0.0346 (CI [-0.0389,-0.0301])。適応k1のみも実質同等 | 棄却。Quoraでは明確に標準BM25より劣る |
| PL2 (DFR) | Quora dev 5,000群、NFCorpus dev 10クラスタ | Hit@10差: Quora -0.0026 (95% CI [-0.0046,-0.0006])、NFCorpus -0.0062 (CI [-0.0063,0])。nDCG@10も双方で低下 | 棄却。別系統の確立モデルだが今回の同一条件では優位なし |
| 標準BM25 + PL2 RRF (k=60) | Quora dev 5,000群、NFCorpus dev 10クラスタ | Quora Hit@10 -0.0004 (95% CI [-0.0014,+0.0006])、nDCG@10 -0.0018 (CI [-0.0026,-0.0010])。NFCorpus Hit@10同率、nDCG@10 -0.0030。p95はQuoraで約2.1倍 | 棄却。PL2単体の悪化は緩和したが優位性なし、レイテンシ増 |
| Bo1クエリ拡張と標準BM25のRRF | NFCorpus dev 10クラスタ、SciFact train 490クラスタ | RRFのHit@10はNFCorpus +0.0154 (CI [0,+0.0158])、SciFact ±0.0000 (CI [-0.0129,+0.0134])。SciFactではMRR -0.0335、nDCG -0.0228、MAP -0.0305。Bo1単独は両方でHit@10/MRRを低下。RRF p95は標準比NFCorpus約4.2倍、SciFact約3.0倍 | 棄却。ドメインをまたぐ安定した改善なし。NFCorpusは正解クラスタ10個のみで区間が粗く、SciFactの主要順位指標は悪化 |
| BM25F title×2 + b=1 の固定組み合わせ | SciFact train 490クラスタ、Quora dev 5,000クラスタ | SciFact nDCG@10 +0.00292 (CI [-0.00238,+0.00844])。Quora Hit@10 -0.0066 (CI [-0.0106,-0.0026])、nDCG@10 -0.01636 (CI [-0.01910,-0.01364])。Quoraは全522,931文書にタイトルが無く、title boostは不活性でb=1単独と同じ順位 | 棄却。b=1の悪化がtitle boostとの合成でも残る。SciFactでもBM25F単独より改善幅が縮小し、区間が0を含む |
| 標準BM25 + title-only BM25 RRF | SciFact train 490クラスタ。RRF title weight=1と、Movies開発から固定転移した0.1 | title weight=1ではnDCG@10 -0.13768 (CI [-0.17285,-0.10395])。weight=0.1でもnDCG@10 -0.03081 (CI [-0.04748,-0.01535])、MRR@10 -0.03937 (CI [-0.06147,-0.01939])。Hit@10差は-0.00124で区間が0を含む | 棄却。等重みの独立タイトル順位が標準ランキングを崩し、弱めた固定信号も上位品質を改善しない。weight=0.1でもp95約1.5倍 |
| 現行UI相当App検索経路（既存の組み合わせ） | 日本語技術記事メタデータ development/validation、各400問・2,484文書 | 標準BM25に対するnDCG@10差はdevelopment +0.02610 (CI [+0.01169,+0.04138])、validation +0.01989 (CI [+0.00428,+0.03673])。Hit@10差は+0.0275/+0.0225。タイトル・タグ由来クエリ | 対象ドメインでは有望だが、自然な利用者検索への一般化未確認。validation Hit@10区間は0を含む。API全経路とranker単体で時間範囲も異なり、独立確認までは採用優位と認定しない |
| 日本語記事BM25補正・信号組み合わせアブレーション | 同じ記事コーパスのdevelopment/validation、各400問 | 現行A0は標準形態素BM25 b=0.75比でnDCG@10 +0.01048/+0.01002。ただしvalidation CIは[-0.00077,+0.02152]。b=0.3の標準形態素BM25はvalidationでA0を+0.00193上回り、方向はdevelopmentで逆。補正なしdual max-normalizedはdevelopment +0.00035、validation -0.00312。dual RRF k=60はvalidation -0.00887 | 安定優位なし。b値をそろえると優位がほぼ消え、各種補正を外す組み合わせ・RRFも検証側で悪化。自己派生クエリによる探索比較 |
| カスタム＋標準BM25 RRFとcorpus-adaptive b | 日本語記事metadata development 400問、JAGOV FAQ development 614問、JAGOV official holdout 1,024問 | RRF A15は記事metadata nDCG@10 0.8130（A0 0.8173、S3 0.8068）、JAGOV development 0.5623（A0 0.5527、S3 0.5695）。重み付きA16/A17も記事0.8171/0.8064、JAGOV 0.5581/0.5651で、各領域の最良単独方式を超えない。JAGOV holdoutはS3 0.5824対A0 0.5542。adaptive b A12もJAGOV holdout 0.5621でS3に届かない。 | 組み合わせてもドメイン間で勝者が変わる。RRFは中間化するが両方で最良ではなく、安定優位なし。JAGOV sourceは既探索であり新規sourceへの独立一般化ではない |
| コーパス長ベースのrankerルーター | 記事metadata development 400問、JAGOV FAQ development 614問 | 平均形態素文書長<40ならA0、それ以外S3を選ぶと記事0.8173、JAGOV 0.5695となり各コーパス既知の勝者を再現 | 閾値と規則を結果観察後に決めたpost-hocルーティング。既知コーパス上のoracle的選択であり、未知コーパスへの安定優位とは認定しない |
| クエリ語×タイトル/タグのrankerルーター | 記事metadata development 400問、JAGOV FAQ development 614問 | A19の緩い一致条件は記事400/400でA0、JAGOV 609/614でもA0を選択。A20はJAGOVの189件をS3に切替えたがnDCG@10 0.5588で、S3 0.5695に対する差は-0.010714 (95% CI [-0.021368,-0.000342])。記事側は全問A0で変化なし | 一致の頻度が高すぎ、厳しいカバレッジ条件でもJAGOV標準に届かない。ルーター候補を棄却 |
| RM3風 relevance feedback | FiQA dev 500問、Quora dev SHA-256固定100問 | nDCG@10差はFiQA +0.00293 (95% CI [-0.00172,+0.00746])、Quora +0.01284 (CI [-0.00443,+0.03122])。Quora Hit@10 +0.030だがCI [-0.010,+0.070]。p50はFiQA約83倍、Quora約114倍 | 二つのdevで主指標改善が確定せず、速度・メモリコスト大。標準BM25優位を覆す根拠なし。本番採用しない |
| Dirichlet / Jelinek-Mercer query likelihood とBM25-RRF | FiQA dev 500問、Quora dev SHA-256固定100問、TREC-COVID test 50問 | FiQAで最良単独nDCG差+0.00315 (CI [-0.00681,+0.01312])。Quora固定転移ではDirichlet mu=250が-0.04121 (CI [-0.08312,-0.00294])、JM lambda=0.5は+0.00296 (CI [-0.01628,+0.02356])。FiQA融合はほぼ0、Quora融合は+0.00811でもCIは0を含み、TREC-COVID融合は-0.00903/-0.00784（1 qrel clusterで推論不可） | 棄却。安定改善なし。全候補文書採点の遅延が大きく、TREC-COVIDでnDCG悪化 |
| SQLite FTS5 morphology / unicode61 / Porter / rank fusion | ArguAna, SciFact hash block 0 and 100, NFCorpus; 100 queries per block | Morphology FTS nDCG@10 +0.00751 (ArguAna CI [+0.00012,+0.01727]), SciFact block 0 +0.00400 ([0,+0.01188]) but block 100 -0.00708 ([-0.01826,+0.00107]). Porter was +0.01792 in ArguAna and +0.01448 in SciFact block 0, both intervals include zero, then -0.00821 in SciFact block 100. NFCorpus has only one positive-qrel component in the selected sample | 初期信号がSciFactの別クエリblockで再現せず。候補間の選択を含む探索診断で、安定優位なし。既定検索へ採用しない |

## 指標の扱い

- 方式系統は同じ候補ロジックを複数データに適用したものを一方式として数える。Bo1の単独再順位とBM25+Bo1 RRFは同じフィードバック方式の2バリアントとして1系統にまとめた。カスタム＋標準RRF、コーパス長ルーター、クエリフィールド一致ルーター、標準BM25＋タイトルcoverageを含む。
- 「189比較」は方式バリアント×データセット/分割の組数。A19/A20を記事metadataとJAGOV developmentで評価した4比較、固定タイトルcoverageのw=0.2によるBEIR転移5比較、重みgridのdevelopment 15比較、選択w=0.4のtest転移5比較、固定w=0.1のWebis-Touche2020転移1比較、RM3のFiQA/Quora dev 2比較、FTS5 morphology/raw/Porter/RRFの5 variantを4つのdataset/query blocksで評価した20比較、query-likelihood 10設定を3データブロックで測定した30比較、固定RRF 2設定を3データブロックで評価した6比較を含む。
- Books/Movies開発データは過去の探索に使われている。今回の候補比較も開発・転移診断であり、独立未使用holdoutによる優位性認定ではない。
- 正解・指標・ゲートは変更していない。探索結果を最終的な利用者再発見率へ一般化しない。

## 組み合わせ方式の追加判断

単独方式に限定せず、標準BM25を維持したまま異なる検索信号をRRFで加える組み合わせも比較した。結果は「組み合わせれば勝てる」ではなく、効果がコーパス依存だった。

| 組み合わせ | 評価範囲 | 標準BM25との差 | 判断 |
|---|---|---|---|
| 標準BM25 + 形態素FTS + raw FTS、三信号RRF (k=60等重み) | SciFact exploratory 300問、NFCorpus test 323問/6関連クラスタ、ArguAna test 1,406問 | nDCG@10: SciFact +0.02764 (95% cluster bootstrap CI [+0.01252,+0.04579])、NFCorpus -0.00142 ([-0.00144,0])、ArguAna -0.00003 ([-0.00155,+0.00146])。Hit@10差は順に+0.02333、0、-0.00071 | SciFactは探索的に改善するが他2セットへ転移しない。NFCorpusは関連クラスタが6個のみで区間推定も不安定。安定優位とは判定しない |
| 標準BM25 + 形態素FTS、二信号RRF (k=60等重み) | SciDocs test 1,000問/350関連クラスタ、Quora test 10,000問 | SciDocs nDCG@10 +0.00102 (95% CI [+0.00007,+0.00172])、Hit@10 +0.00500 ([0,+0.00719])。Quora nDCG@10 -0.00012 ([-0.00027,0])、Hit@10 -0.00010 ([-0.00030,0]) | 改善幅は小さく、別データでは微減。三信号方式と合わせても複数領域での安定優位は成立しない |

三信号RRFは追加探索候補には残すが、既定検索には採用しない。評価群は複数方式の比較に使用済みで、SciFactは300問の探索標本、NFCorpusはqrel依存をまとめたクラスタが6個しかないため、これらの結果を独立した最終検証とは呼ばない。計測レイテンシは複数方式をベンチマーク内で連続採点した全体時間を含むため、個別rankerの増分コストとして扱わない。

## JaGovFaqs上のトークン方式・融合診断

22,794文書のJaGovFaqs開発DBを読み取り専用で開き、development 614問を同じクエリ解析・全コーパス・Top50条件で比較した。これは過去のJAGOV方式探索で使用済みの開発分割であり、独立holdoutではない。ここでの標準比較はSQLite FTS5の形態素BM25で、アプリ独自BM25との同一実装比較とは区別する。

| 方式 | Hit@10 | MRR@10 | nDCG@10 | 標準形態素BM25との差 | p50 / p95 |
|---|---:|---:|---:|---|---:|
| FTS5 morphology BM25 | 0.7296 | 0.5239 | 0.5730 | 基準 | 43.6 / 136.8 ms |
| FTS5 N-gram BM25 | 0.6450 | 0.4633 | 0.5073 | Hit@10 -0.0847 (95% cluster bootstrap CI [-0.1140,-0.0554]); MRR -0.0606; nDCG -0.0657 | 100.0 / 247.3 ms |
| morphology優先、0件時だけN-gram | 0.7296 | 0.5239 | 0.5730 | 全指標差0。614問中フォールバック1問、正解Top10救済0件 | 43.6 / 136.9 ms |

したがって、このデータではN-gram単独は明確に悪化し、単純な0件時フォールバックにも改善効果がなかった。等重みの完全順位RRFは別途3問のスモークで、Hit@10差0、MRR差 -0.1667、nDCG差 -0.1230、p95 24.6秒だった。3問では品質判断できないが、全一致集合を順位付けする費用が大きいため追加の全件評価は見送った。N-gram系を常時融合する根拠は得られていない。

追加で各順位表をTop200に切った近似RRFをdevelopmentから等間隔抽出した100問で測った。Hit@10は0.660から0.640（差 -0.020、95%クラスタbootstrap CI [-0.090, 0.050]）、MRR@10は0.4379から0.4561（差 +0.0182、CI [-0.0234, 0.0611]）、nDCG@10は0.4914から0.5005（差 +0.0090、CI [-0.0325, 0.0499]）。p50は54.2から59.1ms、p95は132.0から128.1ms。Hit@10低下と他指標の不確実な小幅上昇が併存し、候補打ち切りによる速度改善も確認できないため、採用根拠にはならない。100問は既使用developmentからの探索標本で、確認的評価・独立holdoutではない。

続けて同じdevelopment全614問を測定したところ、Hit@10は0.7296から0.7166（差 -0.0130、95%クラスタbootstrap CI [-0.0358, 0.0098]）、MRR@10は0.5239から0.5061（差 -0.0178、CI [-0.0373, 0.0011]）、nDCG@10は0.5730から0.5565（差 -0.0165、CI [-0.0339, 0.0002]）。p50は50.0から58.2ms、p95は141.8から119.5msだった。主要3指標はすべて点推定で低下し、CIは0を含む。p95の改善だけでは品質低下とp50増加を正当化できず、この全クエリ探索でもTop200 RRFを採用しない。

再現用成果物:
- `quality/e2e/artifacts/jagov-dev-ngram-only-readonly-20261023.json`
- `quality/e2e/artifacts/jagov-dev-morph-fallback-readonly-20261023.json`
- `quality/e2e/artifacts/jagov-dev-rrf-pool200-readonly-20261023.json`
- `quality/e2e/artifacts/jagov-dev-rrf-pool200-all-readonly-20261023.json`
- 評価器: `scripts/bench/benchmark_miracl_readonly_hybrid.ts`（読み取り専用SQLite、アプリDB初期化・マイグレーションなし）

この診断は標準BM25を安定して上回る方式の完成を意味しない。現状は、少なくともこの日本語FAQドメインでは形態素BM25を基準として維持するのが妥当で、未使用holdoutでの独立確認と別ドメインへの転移が未達である。

## 完全フィールド一致ルーター A21

A19/A20の続きとして、A0上位3文書のいずれか1件の同一フィールド（titleまたはtag）に、解析された全keyword unitが部分文字列として含まれる場合のみA0を選び、それ以外は標準S3に切り替えるA21を評価した。判定は順位ラベルを参照せず固定ルールで行った。ただし100%閾値はA20の50%結果を見た後に選んだpost-hoc探索条件である。すべて既使用の探索データであり、独立確認ではない。

| 分割 | A21選択A0件数 | A21 nDCG@10 | 標準S3 nDCG@10 | 差 A21−S3（95% cluster bootstrap CI） |
|---|---:|---:|---:|---:|
| JaGovFaqs development 614問 | 138 | 0.5639 | 0.5695 | -0.00568 [-0.01108,-0.00028] |
| 記事メタデータ development 400問 | 341 | 0.8132 | 0.8068 | +0.00637 [+0.00088,+0.01237] |
| 記事メタデータ validation 400問 | 340 | 0.8095 | 0.8068 | +0.00266 [-0.00542,+0.01110] |

記事validationではA21が元のA0をnDCG@10で0.00736下回り（95% CI [-0.01538,-0.00064]）、MRR/MAPも低下した。全keyword一致条件でも標準BM25より安全にA0を選べておらず、JaGovでは標準より明確に悪化した。A21は棄却し、本番検索には採用しない。これはフィールド一致がドメイン内で一定の関連を持つ一方、同じ特徴がカスタムrankerの優位を識別する十分な信号ではないことを示す。

再現用成果物:
- `quality/e2e/artifacts/jagov-development/a21-fullcoverage-router-20261023.json`
- `quality/e2e/artifacts/article-api-ablation/a21-fullcoverage-development-20261023.json`
- `quality/e2e/artifacts/article-api-ablation/a21-fullcoverage-validation-20261023.json`
- 評価器: `scripts/bench/evaluate_bm25_ablation.ts`。実アプリのランキング関数を使うが、`--skip-reference` 指定のため、この実行自体ではproduction `runPipeline` との一致を再照合していない。

## 再現可能なレポート

- IDF: `BM25-IDF-INDEPENDENT-HOLDOUT-RESULTS-2026-10-23-ja.md`
- RRF: `BM25-MORPH-FTS-RRF-HOLDOUT-RESULTS-2026-10-23-ja.md`
- BM25+: `BM25-PLUS-BOOKS-DEV-RESULTS-2026-10-23-ja.md`
- Parser weights: `BM25-PARSER-WEIGHTS-QUERY-SPLIT-RESULTS-2026-10-23-ja.md`
- k1/b: `BM25-PARAMETER-GRID-BOOKS-DEV-RESULTS-2026-10-23-ja.md`
- BM25F: `BM25F-TITLE-BOOST-RESULTS-2026-10-23-ja.md`
- BM25F BEIR固定転移: `BM25F-BEIR-FIXED-TITLE2-TRANSFER-RESULTS-2026-10-23-ja.md`
- BM25 k1/b BEIR固定転移: `BM25-K1B1-BEIR-TRANSFER-RESULTS-2026-10-23-ja.md`
- BM25L: `BM25L-BOOKS-MOVIES-RESULTS-2026-10-23-ja.md`
- JAGOV日本語転移診断: `BM25-JAGOV-ABLATION-TRANSFER-RESULTS-2026-10-23-ja.md`
- A8 JAGOV validation転移: `BM25-A8-JAGOV-VALIDATION-TRANSFER-2026-10-23-ja.md`
- 日本語記事UI検索対標準BM25: `BM25-ARTICLE-API-VS-STANDARD-TRANSFER-2026-10-23-ja.md`
- 日本語記事の補正・組み合わせ比較: `BM25-ARTICLE-ABLATION-COMBINATIONS-2026-10-23-ja.md`
- カスタム＋標準順位融合と適応b: `BM25-COMBINED-RANKERS-EXPLORATION-2026-10-23-ja.md`
- BM25F固定設定の日本語記事転移: `BM25F-ARTICLE-CORPUS-FIXED-TRANSFER-2026-10-23-ja.md`
- BM25-adpt適応型TF: `BM25-ADAPTIVE-TF-QUORA-TRANSFER-RESULTS-2026-10-23-ja.md`
- PL2 DFR: `PL2-BM25-TRANSFER-RESULTS-2026-10-23-ja.md`
- Bo1 feedback / BM25+Bo1 RRF: `BM25-BO1-FEEDBACK-TRANSFER-RESULTS-2026-10-23-ja.md`
- RM3風関連性フィードバック: FiQA dev 500問でHit@10差+0.018 (95% cluster bootstrap CI [+0.004,+0.034])、主指標nDCG@10差+0.00293 ([-0.00172,+0.00746])。Quora dev固定100問ではHit@10差+0.030 ([-0.010,+0.070])、nDCG@10差+0.01284 ([-0.00443,+0.03122])。どちらも主指標は未確定で、Quora p50は標準BM25約22.6msから約2,578msへ増加。比較結果: `BM25-RM3-FIQA-DEV-RESULTS-2026-10-24-ja.md`
- Query-likelihood単体とBM25-RRF: FiQA開発500問、Quora固定hash100問、TREC-COVID test全50問。単体のFiQA小幅差は不確実、Quora固定転移はDirichletで低下。RRFはFiQAほぼ同じ、Quoraは不確実な改善、TREC-COVIDは低下。詳細・JSON: `BM25-QUERY-LIKELIHOOD-TRANSFER-2026-10-24-ja.md`
- FTS5/Porter固定転移: ArguAna/SciFact/NFCorpusを100件SHA query blockで比較。SciFact offset 100 blockでFTS5 morphologyのnDCG差が-0.00708へ反転し、Porterも-0.00821。初期blockの小さな改善は再現しない。計画・詳細: `BM25-FTS5-PORTER-TRANSFER-PREREGISTRATION-2026-10-24-ja.md`
- BM25F title×2 + b=1: `BM25F-TITLE2-B1-COMBO-TRANSFER-RESULTS-2026-10-23-ja.md`
- BM25 + title-only RRF: `BM25-TITLE-ONLY-RRF-TRANSFER-RESULTS-2026-10-23-ja.md`

型チェックは `npm.cmd run typecheck` 成功。本番コードへの採用変更、commit、pushは行っていない。

## 標準BM25＋タイトル一致補正の固定転移（追記）

MIRACL日本語developmentで固定した候補「標準BM25 top1000を候補集合とし、候補内min-max正規化BM25に、解析keyword unitのタイトル部分文字列coverage×0.2を加える」をBEIR TREC-COVID testへ転移した。係数・正解・閾値は変更していない。TREC-COVIDは他のBM25方式探索に既使用なので、これは未使用holdoutではなく候補固有の探索的クロスドメイン診断である。

| 指標 | 標準BM25 | BM25 + title coverage | 差 |
|---|---:|---:|---:|
| nDCG@10 | 0.57853 | 0.59564 | +0.01711 |
| Hit@10 | 0.980 | 0.980 | 0 |
| Hit@1 | 0.720 | 0.740 | +0.020 |
| MRR@10 | 0.82067 | 0.83733 | +0.01667 |
| Recall@100 | 0.11262 | 0.11655 | +0.00393 |
| MAP@100 | 0.07388 | 0.07738 | +0.00349 |
| レイテンシ p50/p95 | 211.8 / 290.2 ms | 214.1 / 295.9 ms | rerank込みで約+2.3 / +5.7 ms |

nDCG@10は50問中26問で上昇、12問で低下、12問で同じ。Hit@10の成否は変わらず、正例qrel文書の欠落も0件だった。複数指標の点推定改善は、タイトル一致をBM25の再順位信号として組み合わせる仮説を次の候補として残す理由になる。

ただし、正解文書の共有関係を考慮すると50問すべてが1つの連結クラスタに入る。従ってクラスタbootstrapの有効な独立標本数は1で、信頼区間・統計的優位は推定できない。見かけ上退化した区間を証拠として扱わない。これは安定優位の証明でも、本番導入の根拠でもない。

計算条件の修正も明記する。最初のKuromoji処理はランキング指標を計算する前に1,000/171,332文書で停止した。全件の実行性を優先し、事前計画に追記した上で、TREC-COVIDだけ文書・クエリ双方に同一のNFKC・小文字化・Unicode単語分割を適用した。したがって本結果はmy-search本番Kuromoji経路の評価ではない。2パスの型付き配列索引は約91 MiB、プロセスRSSは約919 MiB、heapUsedは約173 MiB。レイテンシにはクエリ解析・トークナイズを含まず、ランキング区間を測定した。

再現用成果物:
- 計画: `quality/e2e/docs/TREC-COVID-TITLE-COVERAGE-RERANK-TRANSFER-PLAN-2026-10-23-ja.md`
- 指標・クエリ別詳細: `quality/e2e/artifacts/trec-covid-title-coverage-transfer-final-20261023.json`
- 評価器: `scripts/bench/benchmark_title_coverage_transfer.ts`（コンパクト2パス索引）
- 初回の高メモリ索引方式は構築段階で中断し、指標を出していないため、結果としては不採用。

## タイトルcoverage組み合わせの複数BEIR転移

TREC-COVIDだけの偶然を避ける診断として、同じ重み0.2・同じ候補方式をNFCorpus、SciFact、ArguAna、FiQAのtestへそのまま適用した。いずれも他のBM25方式探索で既使用のtestであり、候補固有の固定転移比較ではあるが、新規の独立確認とはしない。すべてUnicode単語トークナイズで、my-search本番Kuromoji検索とは異なる。

| BEIR test | Q / 関連クラスタ | 標準 nDCG@10 | 組み合わせ nDCG@10 | 差 (cluster bootstrap 95% CI) | Hit@10差 | 判定 |
|---|---:|---:|---:|---|---:|---|
| TREC-COVID | 50 / 1 | 0.57853 | 0.59564 | +0.01711 / NOT_EVALUABLE | 0 | 点推定改善、推測統計不能 |
| NFCorpus | 323 / 6 | 0.31352 | 0.31397 | +0.00045 / [0.00000, 0.00558] | -0.00310 | ほぼ横ばい。6クラスタのみで推定は粗い |
| SciFact | 300 / 247 | 0.66454 | 0.67150 | +0.00696 / [0.00048, 0.01420] | +0.00333 | nDCG/MAP改善、Hit@10区間下限は0 |
| ArguAna | 1,406 / 1,406 | 0.33041 | 0.33951 | +0.00910 / [0.00657, 0.01174] | +0.01991 | このtestでは複数指標が改善 |
| FiQA | 648 / 648 | 0.23156 | 0.23156 | 0.00000 / [0.00000, 0.00000] | 0 | 全57,638文書のtitleが空で、信号が無効 |

SciFact・ArguAnaの2セットでは、固定候補が標準BM25より統計的に正のnDCG差を示した。一方、NFCorpusはほぼ無効でHit@10が微減、FiQAは全順位が同一、TREC-COVIDは1クラスタのため推論不能である。よって「組み合わせ方式は有望」という証拠にはなるが、ドメインをまたぐ安定優位や本番利用での効果とはまだ言えない。タイトル欄の有無・クエリ特性に応じた信号適用が次の仮説だが、今回のtestで条件や重みを後付け調整しない。

検索レイテンシはランキング区間のみ。標準→補正込みのp50/p95は、NFCorpus 0.074/1.117→0.218/2.698ms、SciFact 1.401/3.891→4.382/9.053ms、ArguAna 9.821/15.412→16.478/27.107ms、FiQA 17.304/54.922→17.919/55.696ms、TREC-COVID 211.773/290.229→214.065/295.936ms。候補1,000件の再ソートにより小規模コーパスでは相対負荷が大きい。index構築は2パスのUnicode tokenizationで、TREC-COVIDの型付きposting配列は約91MiB、全体RSS約919MiBだった。

成果物:
- 固定計画: `quality/e2e/docs/TITLE-COVERAGE-CROSS-DATASET-TRANSFER-PLAN-2026-10-23-ja.md`
- TREC-COVID: `quality/e2e/artifacts/trec-covid-title-coverage-transfer-final-20261023.json`
- NFCorpus: `quality/e2e/artifacts/nfcorpus-title-coverage-transfer-test-20261023.json`
- SciFact: `quality/e2e/artifacts/scifact-title-coverage-transfer-test-20261023.json`
- ArguAna: `quality/e2e/artifacts/arguana-title-coverage-transfer-test-20261023.json`
- FiQA: `quality/e2e/artifacts/fiqa-title-coverage-transfer-test-20261023.json`
- 評価器: `scripts/bench/benchmark_title_coverage_transfer.ts`

## 開発選択済みタイトルcoverage w=0.4の固定転移

先行のw=0.2 test結果を見て重みを合わせることを避けるため、NFCorpus dev・SciFact train・FiQA devだけでw={0, .05, .1, .2, .4}を比較し、データセット等重みmacro nDCG@10差が最大となったw=0.4を固定した。w=0.4はグリッド上端なので、連続最適値とは見なさない。開発比較の事前規則と結果は `TITLE-COVERAGE-WEIGHT-SELECTION-PLAN-2026-10-23-ja.md` にある。

| BEIR test | nDCG@10 標準→w=0.4 | 差 / クラスタbootstrap 95% CI | Hit@10 標準→w=0.4 | Q / クラスタ | 読み方 |
|---|---:|---|---:|---:|---|
| TREC-COVID | 0.57853→0.61386 | +0.03532 / NOT_EVALUABLE | 0.980→1.000 | 50 / 1 | 点推定は上昇、独立クラスタ不足 |
| NFCorpus | 0.31352→0.31337 | -0.00015 / [-0.00022, +0.01158] | 0.681→0.684 | 323 / 6 | ほぼ同等。区間推定は6クラスタで粗い |
| SciFact | 0.66454→0.66969 | +0.00515 / [-0.00785, +0.01893] | 0.807→0.813 | 300 / 247 | 点推定改善だがCIは0を含む |
| ArguAna | 0.33041→0.34493 | +0.01452 / [+0.01130, +0.01786] | 0.696→0.730 | 1,406 / 1,406 | 明確な改善。ただし本候補比較は探索的 |
| FiQA | 0.23156→0.23156 | 0 / [0, 0] | 0.474→0.474 | 648 / 648 | 全57,638文書でtitleが空のため完全不変 |

全タイトルが利用できる4データのうち、nDCG点推定は3つで上昇・1つでほぼ不変。ArguAnaでは強い正の差がある一方、統計区間が正となったのはこのセットだけ。SciFactの差は不確実、NFCorpusは実質ゼロ、TREC-COVIDはクラスタ1で推論不可である。クエリ単位のnDCGはTREC-COVID 33改善/16悪化/1不変、NFCorpus 64/53/206、SciFact 31/22/247、ArguAna 181/23/1202、FiQA 0/0/648だった。よって、これは好成績の組み合わせ候補だが、安定優位の達成ではない。

追加レイテンシ（ランキング区間）p50/p95はNFCorpus 0.076/1.299→0.219/3.206ms、SciFact 1.303/3.471→3.972/8.312ms、ArguAna 9.596/15.992→16.145/26.971ms、FiQA 15.921/58.284→16.698/58.956ms、TREC-COVID 231.209/311.882→233.574/314.813ms。小さなコーパスではTop1000の再ソート分が相対的に重い。

開発用重みgrid artifactは`quality/e2e/artifacts/{nfcorpus,scifact,fiqa}-title-coverage-dev-w*-20261023.json`。固定test artifact:
- `quality/e2e/artifacts/trec-covid-title-coverage-w0_4-test-20261023.json`
- `quality/e2e/artifacts/nfcorpus-title-coverage-w0_4-test-20261023.json`
- `quality/e2e/artifacts/scifact-title-coverage-w0_4-test-20261023.json`
- `quality/e2e/artifacts/arguana-title-coverage-w0_4-test-20261023.json`
- `quality/e2e/artifacts/fiqa-title-coverage-w0_4-test-20261023.json`

BEIR test splitは先行の他方式実験に使われており、w=0.2の結果も観測済みであるため、今回のw=0.4 test結果を独立・未使用の最終認定と扱わない。重みは開発分割で固定した後に変更していない。本番検索・DBは未変更。

## アプリ内SciFact/MIRACLでの複合方式追加比較

BEIRの転移結果だけに依存しないよう、リポジトリ内の隔離評価DB（SciFact 5,183文書、MIRACL日本語29,937文書）・固定済み各100クエリでも比較した。これらは既存評価データであり、新規・未使用holdoutではない。クエリ解析・候補データ・qrelsは各方式で共通。今回の比較はオフラインranker診断であり、`runPipeline`との全件一致を確認した比較ではない（`--skip-reference`）。本番ルートへの変更は行っていない。

| データ | 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|
| SciFact | 現行A0 | 0.7097 | 0.9222 | 0.6795 | 0.6642 | 15.87 / 38.77 |
| SciFact | 標準形態素BM25 S3 | 0.7250 | 0.9247 | 0.6943 | 0.6807 | 5.12 / 16.01 |
| SciFact | 現行A0 + title coverage 0.2 | 0.7181 | 0.9347 | 0.6915 | 0.6780 | 19.93 / 44.61 |
| SciFact | 標準S3 + title coverage 0.2 | 0.7230 | 0.9247 | 0.6932 | 0.6828 | 9.05 / 22.44 |
| SciFact | 標準S3 + title coverage 0.4 | 0.7162 | 0.9247 | 0.6813 | 0.6703 | 9.51 / 23.23 |
| MIRACL-ja | 現行A0 | 0.6096 | 0.9375 | 0.5722 | 0.5189 | 5.65 / 35.46 |
| MIRACL-ja | 標準形態素BM25 S3 | 0.5937 | 0.9475 | 0.5510 | 0.5017 | 1.03 / 5.05 |
| MIRACL-ja | 現行A0 + title coverage 0.2 | 0.6240 | 0.9608 | 0.5933 | 0.5426 | 10.93 / 40.39 |
| MIRACL-ja | 標準S3 + title coverage 0.2 | 0.6101 | 0.9533 | 0.5779 | 0.5208 | 3.22 / 12.24 |
| MIRACL-ja | 標準S3 + title coverage 0.4 | 0.6154 | 0.9567 | 0.5868 | 0.5271 | 3.64 / 12.24 |

現行A0にtitle coverage 0.2を重ねる候補は、両コーパスでA0の全4指標を上回った（nDCG差はSciFact +0.0084、MIRACL +0.0144）。qrelsで共有正解文書を連結したクラスタbootstrap 20,000反復の95%区間は、SciFact 85クラスタで[-0.0009, +0.0206]、MIRACL 100クラスタで[-0.0009, +0.0317]と、どちらも0を含む。追加ランキング時間も増え、同じ方式が標準BM25を上回ったのはMIRACLだけでSciFactでは下回った（0.7181対0.7250）。標準BM25にtitle coverageを組み合わせる方式もSciFact nDCGが標準単体より低く、MIRACLでは高かった。重み0.4はSciFactで悪化し、0.2の方が両セットで良かったが、これは同じ既使用クエリ上の比較であり、重み選択の独立検証ではない。

現行A0とtitle coverage 0.2のクエリ別nDCGは、SciFactで改善10・悪化4・不変86、MIRACLで改善16・悪化11・不変73。A24対A0のクラスタbootstrap区間はいずれも0を含み、平均差の正方向だけで「安定優位」とはしない。他の比較方式についてはこの追加集計でクラスタ区間を算出していない。次の確認では、未使用の独立データを確保してから方式と重みを固定し、クラスタ単位の対応あり推定を行う必要がある。

再現用成果物:
- 評価器: `scripts/bench/evaluate_bm25_ablation.ts`（A23標準BM25+title 0.2、A24現行A0+title 0.2を追加）
- SciFact: `quality/e2e/artifacts/app-title-rerank-combinations-scifact-100q-20261023.json`
- MIRACL-ja: `quality/e2e/artifacts/app-title-rerank-combinations-miracl-100q-20261023.json`
- 先行SciFact title 0.4比較: `quality/e2e/artifacts/app-standard-title-coverage-scifact-100q-20261023.json`
- 先行MIRACL title 0.4比較: `quality/e2e/artifacts/app-standard-title-coverage-miracl-100q-20261023.json`

タイトルcoverageを加えた候補は追加検証の価値があるが、コーパスをまたいだ標準BM25への安定優位は未達。本番ランキング・API・ユーザーDBには変更を適用していない。

### 追加：標準BM25とタイトル補正済み現行方式のRRF

title coverageだけで標準方式を安定して超えなかったため、標準S3ランキングとA24（現行A0をタイトルcoverage 0.2で再順位付け）の順位をRRF k=60で統合した。方式と重み候補は50/50と、標準25%・A24 75%を比較した。両入力の各順位表を使い、融合前にさらに候補を切ってはいない。ただしA24自体はA0上位最大1,000候補から作る。計測したRRF時間は融合演算だけで、2つのrankerを作る時間は含まない。

| データ | 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | 標準比nDCG差（95%クラスタbootstrap CI） |
|---|---|---:|---:|---:|---:|---|
| SciFact | 標準S3 | 0.7250 | 0.9247 | 0.6943 | 0.6807 | 基準 |
| SciFact | A25 標準50% + A24 50% | 0.7327 | 0.9247 | 0.7007 | 0.6863 | +0.0077 [-0.0006, +0.0182], 85クラスタ |
| SciFact | A26 標準25% + A24 75% | 0.7227 | 0.9247 | 0.6922 | 0.6781 | -0.0024 |
| MIRACL-ja | 標準S3 | 0.5937 | 0.9475 | 0.5510 | 0.5017 | 基準 |
| MIRACL-ja | A25 標準50% + A24 50% | 0.6092 | 0.9508 | 0.5704 | 0.5179 | +0.0156 [-0.0004, +0.0332], 100クラスタ |
| MIRACL-ja | A26 標準25% + A24 75% | 0.6274 | 0.9508 | 0.5960 | 0.5426 | +0.0338 |

A25は両セットで標準BM25を上回り、全4指標でSciFactは非劣化、MIRACL-jaでは改善した。クエリ正解共有を考慮した20,000回のcluster bootstrapでも平均差は正だが、95% CIは両方とも0を含む。A26はMIRACL-jaでは大きく改善した一方、SciFactでは標準より悪く、重みを現行方式寄りにするほどドメイン依存が強まる可能性を示す。従ってA25を次の固定候補とするが、安定優位の統計的証明ではなく、既使用100問ずつの探索結果である。

融合処理単体のp50/p95はSciFact 0.72/1.37ms、MIRACL-ja 0.31/1.14ms。これはranker両方の実行時間を含まないので、総検索時間として報告しない。A25総コストの見積りには両rankerの実行・メモリを含む別測定が必要。本番検索にはまだ適用しない。

再現用成果物:
- SciFact: `quality/e2e/artifacts/app-title-rrf-fusion-scifact-100q-20261023.json`
- MIRACL-ja: `quality/e2e/artifacts/app-title-rrf-fusion-miracl-100q-20261023.json`
- A25/A26計算: `scripts/bench/evaluate_bm25_ablation.ts`

この比較も`--skip-reference`によるranker単体評価であり、アプリAPI実機の最終検索結果と同一だとは確認していない。A25は次の未使用データ評価に持ち込む固定候補で、本番採用は保留する。

### 全固定クエリでの確認：100問結果は維持されなかった

A25の重みを変えず、評価JSONに含まれる全クエリへ範囲を広げた。これは既用データの追加診断であり、過去に同じBEIR出典・SciFact領域を用いた方式検討もあるため、新規の確認的holdoutではない。

| データ | Q / 文書 | 標準S3 nDCG@10 | A25 nDCG@10 | 差 / 95%クラスタbootstrap CI | MRR差 | MAP差 |
|---|---:|---:|---:|---|---:|---:|
| SciFact | 300 / 5,183 | 0.6766 | 0.6704 | -0.0062 [-0.0169, +0.0041]（247クラスタ） | -0.0076 | -0.0063 |
| MIRACL-ja | 200 / 29,937 | 0.5703 | 0.5785 | +0.0082 [-0.0039, +0.0203]（200クラスタ） | +0.0109 | +0.0105 |

100問だけでは両方で改善して見えたA25が、SciFact全300問では標準BM25より悪化した。MIRACL-ja全200問は点推定で上回るもののCIは0を含む。つまり現時点では、**異なる領域を通じた安定優位は明確に否定される**。100問の初期結果を成功として採用せず、全クエリ結果を優先する。次はSciFactで標準より下がるケースと、日本語で上がるケースの特徴を分解し、共通の適用条件を事前規則化できるか確認する。

再現用全件成果物:
- SciFact 300問: `quality/e2e/artifacts/app-title-rrf-fusion-scifact-300q-20261023.json`
- MIRACL-ja 200問: `quality/e2e/artifacts/app-title-rrf-fusion-miracl-200q-20261023.json`

SciFactのクエリ別差ではA25が標準方式と異なる順位を作ったのは300問中51問だけだった。その51問では改善21・悪化30、残り249問はnDCG差ゼロ。標準がnDCG=1だった163問のうち8問をA25が下げ、A25が新たに満点にしたのは4問だった。順位融合が標準BM25の強い1位を別信号で押し下げるのが、大きな失敗パターンの一つと確認できる。MIRACLでは200問中80問に変化（改善41・悪化39）で、やはり方向はほぼ拮抗している。

### 適応候補：上位3件のタイトル/タグcoverageでrankerを選ぶA20

A25の常時融合ではなく、現行方式の上位3件のいずれか1文書について、解析済みキーワード単位の50%以上がタイトルまたはタグに部分文字列として現れた場合だけ現行方式を使い、それ以外は標準S3を使うA20も、全クエリで確認した。この判定は正解ラベルを見ずに行うが、閾値50%は既存の探索過程で定めたもので、独立検証済みではない。

| データ | 標準S3 nDCG@10 | A20 nDCG@10 | 差 / 95%クラスタbootstrap CI | nDCGが変化したクエリ | p50/p95 ms |
|---|---:|---:|---|---:|---:|
| SciFact 300問 | 0.6766 | 0.6790 | +0.0024 [-0.0025, +0.0081]（247クラスタ） | 改善7・悪化4・不変289 | 4.66/14.79 → 5.19/18.54 |
| MIRACL-ja 200問 | 0.5703 | 0.5762 | +0.0059 [-0.0092, +0.0206]（200クラスタ） | 改善38・悪化33・不変129 | 0.95/7.83 → 3.30/38.73 |

A20の両点推定は標準より高いが、両CIとも0を含む。とくにMIRACLのp95増加が大きい。品質・速度・探索済み閾値の問題が残るため、現時点では標準BM25に安定して勝ったとは言えず、本番適用しない。タイトル/タグの一致が実利用検索で有用な合図かを、未使用コーパスで固定条件のまま検証する価値はある。

### 追加継続：組み合わせ・ルーターとBooks/Moviesの位置づけ

標準BM25を単体で置き換える案だけでなく、複数信号の融合と、観測可能なクエリ特徴で方式を切り替える案も確認した。いずれも既使用データによる探索的診断であり、独立holdoutではない。

#### 形態素＋N-gramの標準BM25融合（S4）

形態素BM25とN-gram BM25の最大値正規化融合を調べた。先のS4対S3比較は、S4が `k1=1.2, b=0.3`、S3が `k1=1.2, b=0.75` であり、BM25パラメータが異なるため融合の効果を分離できていなかった。そこで同じk1/bの単一形態素方式とも比較した。qrelsで関連文書を共有するクエリを連結したcluster bootstrap 20,000回。開発・検証は各400問、qrelクラスタは各400だが、ラベルは自己派生の公開qrels部分集合である。

| 比較 | 分割 | 単一方式 nDCG@10 | 二信号融合 nDCG@10 | 差 / 95%クラスタbootstrap CI | 改善/悪化/不変 |
|---|---|---:|---:|---|---:|
| `b=0.3`: S1形態素 vs S4融合 | development | 0.8113 | 0.8177 | +0.00642 [-0.00210, +0.01531] | 26 / 16 / 358 |
| `b=0.3`: S1形態素 vs S4融合 | validation | 0.8188 | 0.8137 | -0.00505 [-0.01238, +0.00185] | 18 / 20 / 362 |
| `b=0.75`: S3形態素 vs S5融合 | development | 0.8068 | 0.8113 | +0.00450 [-0.00621, +0.01483] | 30 / 21 / 349 |
| `b=0.75`: S3形態素 vs S5融合 | validation | 0.8068 | 0.7929 | -0.01389 [-0.02429, -0.00376] | 18 / 39 / 343 |

S4/S5融合側は形態素・N-gram双方の候補和集合を使い、単一方式側は形態素のみの候補であるため、比較には候補生成範囲の差も含む。開発では両設定とも点推定が上がったが、検証では両方とも下がり、S5のnDCG差は負の区間だった。従って二信号融合に安定した優位は確認できず、本番へ適用しない。JAGOV FAQでS4が0.55655、S3が0.56955だった比較も設定・ドメインの異なる転移診断であり、単独で融合効果とは解釈しない。

#### BM25の `b` の対象別適応（S1）

複雑な補正を加えず、標準形態素BM25の `k1=1.2` を保ったまま `b=0.75` から `b=0.3` に変えたS1を確認した。自作記事コーパスでは検証400問のnDCG差が正で、95%クラスタbootstrap区間も正だったが、開発400問では区間が0を含む。さらにMIRACL日本語では点推定がわずかに負、JAGOV FAQでは明確に負だった。各行はqrelの共有関連文書をクラスタ化した10,000回bootstrapで、転移評価は既使用データによる探索的診断である。

| データ | 文書/問 | 標準 `b=.75` nDCG@10 | S1 `b=.3` nDCG@10 | 差 / 95%クラスタbootstrap CI | p50/p95 ms（S3→S1） |
|---|---:|---:|---|---|---:|
| 自作記事 development | 2,484 / 400 | 0.8068 | 0.8113 | +0.00441 [-0.00286, +0.01192] | 0.34/1.44 → 0.33/1.79 |
| 自作記事 validation | 2,484 / 400 | 0.8068 | 0.8188 | +0.01195 [+0.00340, +0.02189] | 0.33/1.96 → 0.36/2.17 |
| MIRACL-ja exploratory | 29,937 / 200 | 0.5703 | 0.5654 | -0.00489 [-0.02465, +0.01427] | 0.78/7.35 → 0.89/7.42 |
| JAGOV FAQ development | 22,794 / 400 | 0.5649 | 0.5181 | -0.04687 [-0.06399, -0.03046] | 11.34/56.90 → 11.91/55.88 |

同一記事評価内ではS1が有望だが、別の日本語コーパスでは大きく悪化した。`b=0.3` は日本語一般への改善ではなく、記事コーパスの長さ分布への対象依存調整である。S1も本番へ反映せず、記事検索の未使用評価で固定条件を再確認する。

#### 開発データで選ぶクエリ長ルーター

開発400問上で、クエリ長・ASCII語数・両順位のTop10一致度・各ranker上位スコアmargin等の単一特徴しきい値を比較し、最良だった「Unicodeコードポイント長9以上なら現行A0、短ければ標準S3」を検証400問へ固定適用した。検証nDCG@10はA0 0.81683に対してルーター0.81747（差+0.00065、95%クラスタbootstrap CI [-0.00204, +0.00397]）。400問中26問だけS3へ切り替わり、改善6・悪化4・不変390だった。効果は不確実で小さく、ルーター案は採用しない。

#### Movies・Booksを使う理由と限界

Reddit-TOMTのBooks/Moviesは、自然に書かれた「記憶から対象を探す」質問、明示された正解ID、検索対象全体が揃うため、曖昧な再発見クエリへのストレステストや評価器の確認には使える。一方、映画・書籍メタデータの検索は日本語技術記事の再発見とは対象ドメインが異なる。最終品質ゲートや記事検索の代表性能としては扱わない。

Movies development 500問で、標準BM25とA0のRRF k=60はnDCG@10 0.1819、標準S3は0.1783（差+0.0036、95% query-bootstrap CI [-0.0031, +0.0102]）、Hit@10は0.250対0.254だった。改善は統計的に不確実である。タイトル一致率ルーターA20相当は、長いTOMT質問の全specific termを分母にすると500問すべてで標準側を選び、評価値はS3から変わらなかった。これはA20をそのまま別形式の自然文へ移植できないことを示すが、記事検索での失敗を直接意味しない。Moviesのholdoutは使用せず、今回もBooks/Moviesを独立した成功証拠とは見なしていない。

今回の判断は、標準BM25を安定して上回る方式はまだ確立できていない、というもの。S4の二信号融合は同一パラメータ比較で検証分割が悪化し、S1の `b=0.3` は対象記事では有望でもJAGOV FAQへ転移しなかった。記事検索の未使用評価が得られるまで、本番ランキングは変更しない。

再現用既存成果物:
- Movies 500問の検索順位とRRF入力: `quality/e2e/artifacts/movies-dev-current-vs-standard-fresh500-20261023.json`
- アプリ記事S3/S4の開発・検証順位: `quality/e2e/artifacts/article-api-ablation/development-combinations.json`, `quality/e2e/artifacts/article-api-ablation/development-rrf.json`, `quality/e2e/artifacts/article-api-ablation/validation-combinations.json`, `quality/e2e/artifacts/article-api-ablation/validation-rrf.json`
- 記事S1/S3の比較: `quality/e2e/artifacts/article-api-ablation/development-dual-standard.json`, `quality/e2e/artifacts/article-api-ablation/validation-dual-standard.json`
- JAGOV/MIRACLでのS1/S3転移診断（各既使用クエリ、`--skip-reference`）: `quality/e2e/artifacts/jagov-development/s1-b03-vs-s3-exploratory-20261023.json`, `quality/e2e/artifacts/jagov-development/s1-b03-vs-s3-miracl-200q-exploratory-20261023.json`
- JAGOVの方式比較: `quality/e2e/artifacts/jagov-development/combination-rrf-vs-standard-paired.json`

#### 継続実験：標準BM25のコーパス長適応 `b`（S8）

既存評価器の探索規則「平均形態素文書長が40未満なら `b=0.3`、それ以外は `b=0.75`」を、独自補正をすべて無効にした標準形態素BM25へ適用した。これは本番変更ではなく、同じ `k1=1.2`・クエリ解析・候補方式で `S3 (b=0.75)` と比較するための評価専用S8である。閾値40は事前登録されたものではなく、結果を見ながらの探索なので、以下はすべて探索的である。

| コーパス | 平均形態素文書長 | 適応 `b` | S3固定0.75 nDCG@10 | S8適応 nDCG@10 | 差（95%クラスタbootstrap CI） | 判定 |
|---|---:|---:|---:|---:|---|---|
| my-search記事 development（2,484文書/400問） | 23.45 | 0.3 | 0.8068 | 0.8113 | +0.00441 [-0.00288, +0.01190] | 区間が0を含む |
| my-search記事 validation（2,484文書/400問） | 23.45 | 0.3 | 0.8068 | 0.8188 | +0.01195 [+0.00325, +0.02163] | 点推定と区間は正。ただしこの分割も既に探索で繰り返し使用済み |
| MIRACL-ja（29,937文書/200問） | 35.06 | 0.3 | 0.5703 | 0.5654 | -0.00489 [-0.02478, +0.01436]（196クラスタ） | 悪化の点推定、区間は0を含む |
| SciFact（5,183文書/300問） | 217.13 | 0.75 | 0.6766 | 0.6766 | 0（S8はS3と同じ設定） | 変化なし |
| JAGOV FAQ development（22,794文書/400問） | 53.58 | 0.75 | 0.5649 | 0.5649 | 0（S8はS3と同じ設定） | 変化なし |

記事validationでの点推定は有望だが、my-search記事の開発・検証qrelsは自己派生であり、検証分割も繰り返し参照済みなので確認的証拠ではない。MIRACLでの負の点推定は、`b=0.3` の改善が短い平均文書長だけでは予測できないことを示す。SciFact/JAGOVで差がゼロなのは、適応則が既定値0.75を選択したためで、一般化改善を支持しない。

速度は記事コーパスでS3→S8がdevelopment p50/p95 0.32/1.58→0.29/1.35ms、validation 0.26/1.65→0.25/1.63msだった。差は小さく測定揺らぎの範囲とみなし、速度改善とは主張しない。S8はコーパス単位で設定値を選ぶだけで索引・メモリを増やさないが、今回の証拠から標準BM25より安定して優位とはいえない。閾値40の採用や本番化は行わず、独立した未使用の自然検索評価を得るまではS3を比較基準として維持する。

再現用成果物:
- S8評価専用の比較処理: `scripts/bench/evaluate_bm25_ablation.ts`（`S8-standard-morph-corpus-adaptive-b`）
- 記事development/validationと対応あり比較: `quality/e2e/artifacts/article-api-ablation/s8-adaptive-standard-{development,validation}-20261023.json`, `quality/e2e/artifacts/article-api-ablation/s8-adaptive-standard-{development,validation}-paired-20261023.json`
- SciFact 300問: `quality/e2e/artifacts/s8-adaptive-standard-scifact-300q-20261023.json`
- MIRACL-ja 200問の対応あり比較: `quality/e2e/artifacts/jagov-development/s8-adaptive-standard-miracl-paired-20261023.json`（S8は既存S1と同一ランキング）
- JAGOV FAQ 400問: `quality/e2e/artifacts/jagov-development/s8-adaptive-standard-20261023.json`（S8はS3と同一ランキング）

#### 横断診断：標準BM25上位1,000件へのタイトルcoverage rerank（A23）

S8が優位を示さなかったため、既存評価器にあった別信号候補A23（標準S3の上位1,000件を、同じ解析済み検索語のタイトルcoverageで重み0.2 rerank）を5データ分割で再集計した。順位比較はqrelsの共有関連文書でクエリをクラスタ化し20,000回bootstrapした。どれも既使用の探索データであり、確認的な汎化証拠ではない。

| データ | S3 nDCG@10 | A23 nDCG@10 | 差 / 95%クラスタbootstrap CI | p50/p95 ms（S3→A23） |
|---|---:|---:|---|---:|
| my-search記事 development（400問） | 0.8068 | 0.8062 | -0.00069 [-0.00692, +0.00562] | 0.32/1.58 → 1.90/6.06 |
| my-search記事 validation（400問） | 0.8068 | 0.8091 | +0.00227 [-0.00255, +0.00730] | 0.26/1.65 → 1.74/6.38 |
| SciFact（300問/247クラスタ） | 0.6766 | 0.6791 | +0.00253 [-0.00508, +0.01036] | 4.78/15.27 → 8.42/20.57 |
| JAGOV FAQ development（400問） | 0.5649 | 0.5728 | +0.00789 [-0.00111, +0.01704] | 12.36/55.36 → 19.86/65.06 |
| MIRACL-ja（200問/196クラスタ） | 0.5703 | 0.5825 | +0.01214 [+0.00218, +0.02292] | 0.78/7.35 → 3.43/12.95 |

A23は5分割中4つで点推定が正、MIRACL-jaでは区間も正だった一方、自作記事developmentではごく小さく負で、他の区間は0を含む。候補は標準BM25の上位1,000件内だけなので候補Recallは増やさず、タイトルに元の意味語が現れる文書を押し上げる機能である。p95は全分割で増え、特にMIRACLでは1.8倍、記事分割では約4倍となった。従ってこれは「安定優位が確立した」結果ではないが、現在の候補中では異なる検索課題へ比較的広く正方向の点推定が出た優先調査候補である。

次に進める場合は、A23をさらに同じデータで係数調整するのではなく、タイトル語が人間の自然な再発見クエリに有効かを、未使用で出典・正解IDが明確な記事検索評価で一度だけ検証する。加えて、タイトルcoverage計算を候補スキャンのホットパスに入れずに実装できるか、p95コストを含めた採用基準を先に固定する。新しい未使用の自然検索qrelsは現在確認できていないため、統計的な確認は未実施である。

横断A23の再現用成果物:
- Article development/validation: 上記 `s8-adaptive-standard-{development,validation}-20261023.json` と対応する `*-paired-20261023.json`
- SciFact: `quality/e2e/artifacts/s8-adaptive-standard-scifact-300q-paired-20261023.json`
- JAGOV: `quality/e2e/artifacts/jagov-development/s8-adaptive-standard-paired-20261023.json`
- MIRACL-ja: `quality/e2e/artifacts/jagov-development/s8-adaptive-standard-miracl-paired-20261023.json`

#### 追加診断：タイトルcoverage重み0.1のJAGOV 1,024問への転移

探索データで固定したA27（標準BM25上位1,000件をタイトルcoverage重み0.1で再順位付け）を、JAGOV FAQの1,024問・22,794文書へ適用した。クエリIDとqrelsは全1,024件で対応している。比較は検索方式を除き共通のコーパス、クエリ解析、評価指標を使用し、関連文書を共有するクエリを結合単位にしたpaired bootstrap 20,000回を行った。

| 方式 | nDCG@10 | Recall@100 | MRR@10 | MAP@100 | p50/p95 ms |
|---|---:|---:|---:|---:|---:|
| 標準形態素BM25 S3 | 0.58241 | 0.87695 | 0.53338 | 0.53944 | 10.82/51.13 |
| A27 title coverage 0.1 | 0.58726 | 0.87695 | 0.53956 | 0.54584 | 18.54/59.03 |
| 差（95% cluster bootstrap CI） | +0.00485 [+0.00124, +0.00860] | 0.00000 [-0.00391, +0.00391] | +0.00617 [+0.00216, +0.01051] | +0.00640 [+0.00236, +0.01068] | p50 +71%, p95 +15% |

この結果は、候補方式が未評価だったJAGOVの1,024問で正方向の差を示す追加材料であり、Books/Moviesのような異ドメイン代理データより日本語FAQ検索に近い。ただし、JAGOVコーパス自体は以前から他方式の比較に使用済みで、A27も複数データセットを見た後に選んだため、独立した事前登録済み確認試験ではない。単一の追加データ分割であり、多数の探索候補に対する多重性補正もしていない。したがって「安定して優位」とは結論しない。

また、再順位付けのp50は約7.7ms、p95は約7.9ms増え、Recall@100は変化しない。候補再現率ではなく上位順序を改善する信号である。実際の保存技術記事における自然な検索クエリに対する独立評価と、レイテンシを抑えた実装の両方が必要。本番ランキングには適用しない。

再現用成果物:
- 固定A27/JAGOV 1,024問: `quality/e2e/artifacts/jagov-holdout-bm25-stability/a27-title01-posthoc-20261023.json`
- S3との対応あり比較: `quality/e2e/artifacts/jagov-holdout-bm25-stability/a27-title01-posthoc-paired-20261023.json`

#### 追加診断：タイトルcoverage重み0.1のSciDocs test転移

固定重み0.1をSciDocs公式testの1,000問・25,657文書にも適用した。比較には同一のUnicode語トークナイザー、標準BM25上位1,000件、qrels、クエリを使用。正解文書共有で350クラスターを作り、paired cluster bootstrapを行った。SciDocs自体は以前に重み0.4で評価済みのため、これは未使用コーパスの確認試験ではない。

| 指標 | 標準BM25 | title coverage 0.1 | 差 / 95% cluster bootstrap CI |
|---|---:|---:|---:|
| nDCG@10 | 0.15412 | 0.15559 | +0.00147 [-0.00007, +0.00247] |
| Hit@10 | 0.485 | 0.487 | +0.00200 [0, +0.00289] |
| Recall@100 | 0.35125 | 0.35420 | +0.00295 [-0.00144, +0.00470] |
| MRR@10 | 0.27524 | 0.27651 | +0.00127 [-0.00172, +0.00383] |
| MAP@100 | 0.10460 | 0.10566 | +0.00106 [+0.00060, +0.00215] |

レイテンシp50/p95は7.67/24.33msから9.66/26.68msへ増加した。方向はほぼ正だが、主指標nDCGの区間はわずかに0を含み、改善幅も小さい。JAGOVでは同じ重みでより明確な差が出た一方、SciDocsではほぼ同等であり、タイトル信号の利得は一様ではない。データセット横断の「安定優位」を主張する証拠にはまだ足りず、本番採用もしない。

再現用成果物: `quality/e2e/artifacts/scidocs-title-coverage-w0_1-test-20261023.json`

#### 追加診断：Quora duplicate-question test 10,000問

同じ固定重み0.1をQuoraの公式test 10,000問・522,931文書にも適用したところ、Hit@1/10、Recall@100、MRR@10、nDCG@10、MAP@100の全指標が標準BM25と完全一致した。95% cluster bootstrap区間も全指標 `[0, 0]`。処理時間はp50 11.97→12.40ms、p95 76.33→76.84msだった。

コーパスを全件走査して確認すると、522,931件すべてに`text`はある一方、非空の`title`は0件だった。従ってこれはタイトル信号の効果を評価できるデータではなく、title coverageが全候補に同じ0点を加えるno-opケースである。少なくともこのデータ構造では品質を落とさず標準BM25相当へ退化するが、タイトル信号の一般的な有効性を支持も反証もしない。実装側では、タイトル欠落・空欄時に不要なrerank計算を避けられるかを別途検討する余地がある。

再現用成果物: `quality/e2e/artifacts/quora-title-coverage-w0_1-test-20261023.json`

#### 実ルート相当の候補生成・タイトル補正比較（手書き50問）

既存の`benchmark:article-search`へ評価専用の3条件を追加し、アプリのopt-in `fts5-title-rerank`経路に合わせて、形態素FTS5上位1,000件から重み0、0.1、0.2を比較した。クエリ解析後の同じ形態素トークン、同じSQLite FTS5候補順位、同じ手書き50クエリ・正解IDを使用した。これはHTTPを通さない独立SQLite索引での診断で、233文書の小規模データに限る。

| 条件 | P@1 | R-Precision | MRR@10 | nDCG@10 | MAP@100 | p50/p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| 形態素FTS5上位1,000・補正なし | 0.8400 | 0.7500 | 0.8712 | 0.8328 | 0.7928 | 0.588/1.719 |
| 同じ候補・title coverage 0.1 | 0.8400 | 0.7500 | 0.8712 | 0.8328 | 0.7928 | 0.522/1.624 |
| 同じ候補・現行opt-in既定0.2 | 0.8400 | 0.7500 | 0.8712 | 0.8328 | 0.7928 | 0.527/1.640 |

三条件の全ランキング指標は一致している。時間差は数十マイクロ秒規模で測定揺らぎと見なし、速度改善とも言わない。このケースではタイトル信号が品質改善を生まず、既定0.2を有効にする根拠は得られなかった。先のA27（標準BM25 S3上位1,000件を再順位付け）とは候補ランキング方式が違うため、A27の改善をこの実ルートへそのまま適用できるとは言えない。一般化可能な結論ではなく、より大きい技術記事コーパスの実検索評価が必要である。

評価器は[scripts/benchmark_article_search_engines.ts](/C:/Users/jingh/my-search-app_public/scripts/benchmark_article_search_engines.ts)に追加し、生成結果は`artifacts/article-search-engine-comparison-2026-10-23T14-26-03-477Z.json`へ保存した。製品コードと既定設定は変更していない。

#### 追加の固定転移：Webis-Touche2020 test

議論検索という新しいタスク領域で、既存固定候補のタイトルcoverage重み0.1を調整せず評価した。BEIR公式配布ZIPのMD5は`46f650ba5a527fc69e0a6521c5a23563`で、ローカル取得物も一致した。全382,545文書・公式test 49問を使い、正例共有に基づく独立clusterは44個だった。入力SHA-256はcorpus `52e5585b5c23164d37cf9a59cf5d3f55645e0efeec8cd8cdb6b0bd37e48ec111`、queries `8658a223ac9ea050f0d37483dee7037c7c8854e58ce09d01d81a7d071d8caa0d`、qrels `cfaaa2e7820ae9a6913d2e6fe1bd23c8c8b2c4c7ecf102e780704344e35bc4e6`。

| 指標 | 標準BM25 | title coverage 0.1 | 差 / 95% cluster bootstrap CI |
|---|---:|---:|---:|
| nDCG@10 | 0.34536 | 0.34489 | -0.00047 [-0.01011, +0.00895] |
| Hit@10 | 0.91837 | 0.89796 | -0.02041 [-0.06522, 0] |
| Recall@100 | 0.56625 | 0.56996 | +0.00371 [-0.00128, +0.00953] |
| MRR@10 | 0.59864 | 0.60034 | +0.00170 [-0.02837, +0.03163] |
| MAP@100 | 0.22023 | 0.22158 | +0.00135 [-0.00183, +0.00457] |

nDCGは16問で改善、13問で悪化、20問で不変。Hit@10は45/49から44/49へ1問分低下した。主指標の区間は0を含み、安定した改善の証拠はない。タイトルcoverageは上位100件内の再現率をわずかに上げたものの、上位10件の質を改善せず、Hit@10は点推定で悪化したため、この領域では固定候補を採用しない。

ランキングのみのp50/p95は標準BM25の37.75/197.18msから38.82/207.48msへ増加。プロセスRSSは約1.86GB、heapUsedは約0.41GBであり、メモリ値はベンチマークプロセス全体の値である。BEIR配布ZIPは `.tmp-ir-transfer/webis-touche2020/` に隔離し、本番データには触れていない。

この49問のTouche testは、過去のBM25方式探索では使われていなかった候補固有の固定転移診断であり、データセットが小さく、タイトル補正を含む候補方式も複数評価済みのため、正式な独立確認試験とは呼ばない。結果は重み選択や開発へ再利用しない。

再現用成果物:
- 事前固定計画: `quality/e2e/docs/TOUCHE2020-TITLE-COVERAGE-TRANSFER-PLAN-2026-10-23-ja.md`
- 指標・クエリ別順位・入力fingerprint: `quality/e2e/artifacts/webis-touche2020-title-coverage-w01-20261023.json`
- 評価器: `scripts/bench/benchmark_title_coverage_transfer.ts`
