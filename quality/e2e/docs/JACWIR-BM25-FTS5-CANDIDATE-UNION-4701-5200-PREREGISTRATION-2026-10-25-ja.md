# JaCWIR BM25+FTS5候補和の事前登録: query 4701–4991

登録: 2026-10-25 JST  
状態: ランキング結果を見る前に対象・候補集合・指標・判定基準を固定。原本のdistinct queryは4,991件であり、末尾は291件のため、その全件で実行する。

## 仮説

標準BM25と同じ形態素トークンを使うFTS5でも順位は異なる。両者のTop-100候補を和集合にすれば、単独BM25 Top-100が取りこぼすknown-positiveを一部回収し、RRF順位付けで上位品質を維持・改善できる可能性がある。前のJaCWIR 1701–2200評価ではFTS5単独/RRFの順位改善は確認されなかったため、本試験は方式変更ではなく候補生成の別仮説を検証する。

## 固定条件

- 出典: ローカル公式`hotchpotch/JaCWIR`原本。collection/eval Parquetは読み取り専用。
- query: distinct queryをSHA-256(query)昇順にし、残存する4701–4991番の291件を全件採用。元の500件要求はquery母数4,991件のため不可能と判明。抽出時点で検索順位・精度指標を見ておらず、評価前に標本数のみ訂正した。query SHA-256 `e2e895574a80591b2eaa6f73a7925d914ada797f2e6e5e6184bcd13624d10722`、qrels SHA-256 `b056c41d0a944b525320b82c1f49b3def438c8d8e9c37fa833a104c7525b1603`、manifest SHA-256 `bb350f437ce232ae4a2e636fc2d40722417f90bdfd8e1404cae388d54bd15cfe`、qid集合SHA-256 `df9e84a10ac7cf317dae769276fe375fa4704e50a21261e9b22e22925a4980a7`。500件正解ラベルの292 positive qrels。過去に作成済みのlocal query blockとのqid重複0。
- corpus: 513,107件。同一corpus由来のread-only標準形態素BM25 postings indexとFTS5 morphology indexを使用。件数と全doc IDの完全一致を検索前に検証する。
- parser/tokenizer: `purposeWords()` → `analyzeQuery()` → Kuromoji形態素tokenize。ランキング方式間で同じtoken列。
- baseline: 全コーパス標準BM25 Top-100 (`k1=1.2,b=0.75`)。
- candidate: SQLite FTS5 morphology BM25 Top-100。
- primary candidate: BM25とFTS5 Top-100の和集合（最大200件）、各ランキングのmissing rankは寄与0、present rankには`1/(60+rank)`を足すweighted sumで融合し、最終Top-100を返す。
- 比較: BM25単独Top-100、FTS5単独Top-100、Top-100和集合RRF。
- parameters, tokenizer, qrels, candidate depth, metricsを評価後に調整しない。

## 指標・判定

- 主指標: 和集合RRF−BM25のknown-positive nDCG@10差。正例共有queryをcluster化したpaired bootstrap 20,000回、両側95% percentile CI。
- 統計的改善: 平均nDCG差>0、CI下限>0。
- 追跡: Hit@1/10、MRR@10、MAP@100、Recall@100、BM25/FTS5/union candidate positive coverage、候補和集合のサイズ、query p50/p95、索引容量、RSS/heap。
- 暫定実用基準: 最終Hit@10>=0.95、Hit@1>=0.80、nDCG@10>=0.85、候補和集合のpositive coverage>=0.98、query p95<=500ms。統計的改善と実用目標到達は別判定。

## 制約

qrelsはknown-positiveのみで網羅的ではなく、質問は記事から生成されたベンチマーク質問。成功しても実利用者・保存カードへの優位を意味しない。production ranking、ユーザーDB・カード・メモ・Readerは変更しない。commit/pushしない。

標本数が事前想定500から291へ縮小したため、検定区間は広くなり得る。500問の評価と同等の精度・検出力は主張しない。初回の500件抽出試行は原本のquery数不足で生成器が停止し、順位計算には到達していない。部分生成ディレクトリはそのまま保持し、正式な291件評価は別ディレクトリに生成する。

## 結果（2026-10-25）

事前登録した291問・513,107文書の評価を完了した。BM25とFTS5の文書件数は513,107で一致し、全ID集合も完全一致した。292 positive qrelsはいずれもBM25文書索引内に存在した。

| 方式 | Hit@1 | Hit@10 | nDCG@10 | MRR@10 | Recall@100 | p50/p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| 標準形態素BM25 Top-100 | 0.7320 | 0.8969 | 0.81427 | 0.78768 | 0.95189 | 30.34 / 124.38 |
| FTS5形態素BM25 Top-100 | 0.7320 | 0.8969 | 0.81472 | 0.78826 | 0.95189 | 287.11 / 872.54 |
| BM25 + FTS5候補和集合RRF Top-100 | 0.7320 | 0.8969 | 0.81427 | 0.78768 | 0.95189 | 329.36 / 951.78 |

候補集合のknown-positive coverage（positive qrels単位）はBM25 Top-100=`0.94863`、FTS5 Top-100=`0.94863`、union最大200=`0.94863`。FTS5はBM25 Top-100外の正解文書を追加回収せず、和集合の最終ランキングはBM25と同じ品質だった。

FTS5単独−BM25のnDCG差は`+0.000450`（291クラスタpaired bootstrap 20,000回、95% CI `[0.000000, 0.001350]`）。Hit@10差は0。区間下限が0であり、事前基準の統計的改善を満たさない。union RRF−BM25のnDCG/Hit@10差とCIはいずれも`0`。

FTS5単独p95は約873ms、候補和集合RRFは約952msで、暫定500ms上限を超過した。標準BM25 p95は約124ms。BM25索引977,752,064 bytes、FTS5索引1,170,944,000 bytes、評価プロセスの最大RSS約1,019,666,432 bytes、最大heap約604,365,880 bytes。

### 判断

この同一トークン・同一コーパス条件では、FTS5を候補生成源に足す仮説は棄却する。候補再現率の改善がなく、順位品質も改善せず、レイテンシと索引容量の負担が増えた。これはFTS5一般の否定ではなく、この形態素トークン索引をBM25へ足す方式の否定である。製品ランキングは変更しない。

評価スクリプト: `scripts/bench/benchmark_jacwir_fts_candidate_union.ts`  
確定結果: `quality/e2e/artifacts/jacwir-bm25-fts5-union-291q-4701-4991-20261025-preregistered-verified.json`
