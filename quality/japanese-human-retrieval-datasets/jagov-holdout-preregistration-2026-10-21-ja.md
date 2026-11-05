# JaGovFaqs 最終ホールドアウト事前登録

登録日時: 2026-10-21 (Asia/Tokyo)

## 評価対象

- データ: JaGovFaqsRetrieval。公式FAQ質問と対応回答の既存ラベルであり、my-searchの実利用検索ログではない。
- コーパス: `local_article_corpus/japanese-human-retrieval/jagov-api/documents.jsonl` の22,794文書すべて。
- 評価分割: SHA-256固定分割のholdout全件。1,024クエリ、1,024 group、各group 1クエリ、各クエリ1正解。開発・検証分割とのgroup重複なし。
- 比較用全件manifest: `holdout-groups.json` は全1,024 group/queryを含み、seed=`jagov-holdout-all-groups-prereg-2026-10-21-v1`、ファイルSHA-256=`990392c01a76cdb4b8f77a88e311dc565c83079544e9d362a9c3e7549d25d76e`、内部canonical manifest SHA-256=`17f404e59a8554238f06de5707a486d1cc4e1c46d59787dd6b27304c9f0fd713`。
- 質問ファイルSHA-256: `82663ea03b85ef82cd757380f9e0766934d657c8dc712f63c2a8e5cf7dffb2e7`。
- API用コーパスファイルSHA-256: `5222477847a65862184808d4ef338c4845c0baeef886d3346b5c968f56e9c10e`。
- 取得元コーパスSHA-256: `0511e630f06d55a82bdd9fdb6ed096fbed3265d34081a2a7378710181b77d5fa`。質問・qrels・split各SHA-256は元配布manifestを正とする。
- データセットprovenance: `local_article_corpus/japanese-human-retrieval/jagov-api/provenance.json`。元配布manifestのコーパス・質問・qrels SHA-256とCC BY 4.0表記を使用する。

## 固定する検索条件

- 実装指紋: `sha256:3501d715fa89913d1a69aa6b56e1c2029fd72fde880ee5c2bd1eefcb785ec0c0`。
- my-searchのgit HEADは登録時点のHEAD。未コミット変更を含むため、上記worktree指紋を実装状態の識別子とする。
- 主方式: UI相当の `theory` 設定。410件の独立validationで事前選択し、holdout結果を見て選択・調整しない。
- 検索経路: `POST /api/search/terms` の解析後、`POST /api/cards/search` を呼ぶ。全文書は隔離SQLiteにアプリの保存形式で事前投入する。
- APIリクエスト設定: `theory` の `k1=1.8`, `b=0.8`, `lambda=0.02`, `contextBonus=2.2`、`/api/search/terms` が返すキーワードと重み、UIと同じ既定の形態素/N-gram重み (`0.3/0.7`)、除外語なし、source/status絞り込みなし。UIがこの二つの重みをAPI設定に明示しないため、`runPipeline` の既定値を使用する。
- options: `dedupThreshold=1` (重複排除無効)、`archiveScoreThreshold=0.5`、`resultLimit=50`。Hit@10は返された先頭10件に正解があれば成功。
- APIエラー、無効レスポンス、タイムアウト、空結果は失敗として分母に含める。エラー時の再試行はしない。
- 比較対象: 同じholdoutと隔離DBの保存済み形態素トークンを使う独立標準BM25 (k1=1.2, b=0.75、アプリ検索補正なし、クエリ解析はアプリと共通)。この比較は二次的で、95%絶対成功率の認定条件を変更しない。

## 判定方法

- 主指標はJaGovFaqs holdoutのHit@10のみ。
- 帰無仮説 `H0: p <= 0.95`、対立仮説 `H1: p > 0.95`、片側 `alpha=0.025`。
- 独立試行単位は質問ではなく、同一正解文書を共有する質問をまとめた事前固定group。holdoutは1,024個のgroupから1問ずつで、正解文書も相互に異なる。
- 各groupの成否に対するClopper-Pearson片側97.5%信頼下限を報告する。成功数987/1,024以上で初めて下限が0.95を超える。併せて `p=0.95` に対する正確二項上側確率を報告する。
- UI/API方式と標準BM25の差は対応ありで報告し、改善数・悪化数と厳密McNemar両側p値を示す。依存や設計制約がある場合は因果的優越を主張しない。
- holdout結果を見た後の修正・閾値変更・方式選択は禁止。同じholdoutを再評価して認定しない。

## 事前固定した評価コマンド

実行環境にはPythonがOS標準パスにないため、Codex同梱Python runtimeで以下を実行する。API方式の単一評価では `quality/e2e/tools/benchmark_api.py` を使い、`--stage holdout --final --mode-id theory --profile current --dedup-threshold 1 --reuse-db <holdout専用DB>` を指定する。標準BM25は `quality/e2e/tools/standard_bm25_from_seeded_db.ts` でholdout全1,024件を同一DBから評価する。両者のコードと上記実装指紋を実行前に照合し、結果ファイルが既に存在しないことを確認する。

評価器SHA-256: `benchmark_api.py` = `3eef6950acdd90293239d4e057138aa65db7c6c918ff792bc11e3e94fbf93a27`; `standard_bm25_from_seeded_db.ts` = `9c5180cf63cc231ae3a7b6080508b35294888008ad8731398bc8b0a611d81562`; `stats.py` = `403dfbfcf7692a98a41541dddc2fc102ee83e2734639abec9b7afca0b17583d8`.

既存 `quality/e2e/local/holdout_consumed_jagovfaqs_097233e72932.json` と主結果ファイルが存在しないことを実行直前にも確認する。

## 解釈上の境界

本評価はJaGov FAQの質問から対応FAQ回答を検索する性能であり、保存された個人記事の再発見率や一般利用者の自然検索成功率を代表しない。FAQ回答に質問文が含まれるなど、評価が容易になる可能性も含むデータセット固有の推定である。MIRACL日本語は別コーパス・別結果として扱い、JaGovと合算しない。
