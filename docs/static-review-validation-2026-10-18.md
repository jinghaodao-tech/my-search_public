# 静的レビュー指摘の検証・修正結果

検証日: 2026-10-18 (Asia/Tokyo)

追加確認: [サイト機能との統合検証](site-integration-review-2026-10-18.md)で、情報源重複・サイト索引・障害伝播などに未解消の不整合が見つかった。本書のテスト成功をサイト機能との統合完了と解釈しないこと。不明日付・収集排他・HTTP検証の修正も、サイトの別経路には適用し切れていなかった。

対象: my-search_public の現在の作業コピー。着手前から存在した未コミット変更は保持した。新しい収集元、検索エンジン、AI機能、大幅なUI変更は今回追加していない。Gitへのcommit、push、PR作成は行っていない。

## 判定と対応

| 問題 | 判定 | 原因・修正 | 検証 | 残課題・制限 |
|---|---|---|---|---|
| 日本語タイトルの記事ID衝突 | 確認・修正 | タイトルslugを廃止。RSSはフィードでスコープしたGUID、なければURL、arXivは論文識別URL、GitHubは既存の数値IDを使用 | `collector-review.test.ts`: 日本語・同名タイトル・再取得 | GUIDもURLもないフィードはタイトルと本文による代替識別。本文変更時の同一性は保証できない |
| 新IDと既存記事・メモの互換性 | 修正 | URLの保守的正規化で既存IDを維持し、新しい収集IDを`article_aliases`で照合。旧slugが別URLと衝突した場合は別IDへ退避 | 旧ID・保存カード・候補状態・初回発見日時の保持テスト | 過去に上書きされて既に失われた記事本文は復元できない |
| URLを持たない記事が同じ保存先になる | 確認・修正 | フィードURLを記事URLとして代用しない。空URLだけユニーク制約から除き、非空URLの制約は維持 | GUIDだけの2記事をSQLiteに保存 | 出典リンクがないこと自体は解消しない |
| 重複URLの収集・更新 | 確認・修正 | フラグメントと限定的な追跡パラメータを除去。内容を識別するクエリ、パス、HTTP/HTTPSの区別は保持。1バッチ内は1件、再収集は既存IDで更新 | 旧ID照合、URLクエリ区別、既存JSON移行テスト | 過去に存在する別IDの類似URL記事は、関連を失わないよう破壊的に統合しない |
| `/cards/import-articles`の重複 | 確認・修正 | キャッシュではなくSQLiteから対象を取得。カード作成と候補への保存リンクを原子的に更新。旧`card_from_`形式は既存カードと再関連付け | 繰り返しインポートで1件→0件 | 出所が判別できない既存の手動カードは自動統合しない。通常の手動カード作成は同じURLでも可能 |
| カード削除後に候補が保存済みのまま | 再現・修正 | 削除トリガーで`reviewed_not_saved`へ戻し、保存リンク・保存日時を解除。再確認日時と保持期間を更新。既存の矛盾行も移行時に修復 | 単体・一括削除、保持期間、再保存、旧DBアップグレード | カード削除はカード内メモの削除という従来仕様を維持 |
| Reader本文と両方式トークンの不一致 | 再現・修正 | 本文とタイトルのハッシュ付きでReader側に両トークンを保存。ハッシュが違うキャッシュは使用しない。旧キャッシュは最初の検索で補完し永続化 | 新本文のトークン、旧トークンの除外、繰り返し検索時のキャッシュ不変 | 旧DBの初回検索時だけ補完コストがある |
| 記事取得経路によって本文が違う | 再現・修正 | 一覧とID取得の両方でReader全文を優先。Readerコピーは収集で上書きしない | ID取得と一覧取得の本文一致、RSS更新後の本文維持 | Readerが未取得なら従来の抜粋を使用 |
| Readerタイトル・URL編集がカードに反映されない | 再現・修正 | カードのタイトル・URL・本文・タグとReader全文を同時更新。カードトークンとFTS5の既存更新経路を維持 | 編集後のメタデータ、更新失敗時のロールバック | 保存済み本文が長い場合は従来どおりカードに抜粋、Readerに全文を保存 |
| Reader保存が部分的に成功する | 再現・修正 | カード、候補状態、全文、検索用Readerキャッシュを同一SQLiteトランザクションで確定。トークン化はトランザクション前に準備 | 全文保存エラー、単独保存、編集エラー、並行保存、再試行 | HTML抽出だけの操作は、カードを作らない独立した検索キャッシュ操作 |
| 409後にもReaderキャッシュが変わる | 再現・修正 | 候補の状態確認前のDB変更を廃止。トランザクション内の競合確認で失敗すれば全て戻す | 409後にキャッシュ行が増えないことを確認 | なし |
| 同じ段落数なら古い翻訳を再利用する | 確認・修正 | 段落数だけでなく原文の一致を確認して既存翻訳を保持 | Reader・翻訳の既存テスト群 | 機械翻訳自体の品質は今回の対象外 |
| カード全件保存が残存カードを削除・再作成する | 確認・修正 | `saveCards`で残るカードはUPDATE。実際に消えるカードだけDELETEし、Readerコピーと候補リンクを保持 | 保持カードの全文・保存済み候補状態を確認、既存カードテスト | なし |
| 収集設定が再起動で失われる | 確認・修正 | SQLiteの`collector_settings`へ設定保存。初回は従来の既定値 | サービス再作成で設定復元、管理APIテスト | スケジューラーの自動起動設定は今回追加しない |
| 起動中スケジューラーが古い設定を使う | 確認・修正 | 各実行時に最新の設定を参照 | 設定変更後の次回実行テスト | 開始済みの収集は開始時点の設定で完了する |
| 手動・定期・起動直後の収集の競合 | 確認・修正 | 同じサービスの実行ロックを利用し、スケジューラーの重複tickも抑止。手動競合は409。定期失敗はジョブとログに記録 | 重複実行、起動直後の失敗、停止後のtick、既存ジョブテスト | 単一アプリプロセス内の排他。複数サーバープロセスを同じDBに向ける分散排他は未対応 |
| 収集の二重保存 | 確認・修正 | `collectAll`が保存を所有。スケジューラー完了通知はキャッシュ更新のみ。fixtureもサービスで一度だけ保存 | 収集・ジョブ・E2Eテスト | なし |
| DB保存エラーを成功扱い | 再現・修正 | `saveArticles`の例外握り潰しを廃止。保存失敗をAPI/ジョブへ伝播 | SQLiteのABORTトリガーで失敗注入 | 成功した外部取得でもSQLite保存が失敗すれば今回のジョブは失敗 |
| 1情報源の失敗で他の成功結果を失う | 既存設計を維持・検証 | 情報源ごとのエラー配列を維持し、成功結果は保存 | 成功RSSと失敗RSSの混在テスト | エラー配列がある部分成功を完全成功とは表示しない |
| 最新取得件数と累積件数、試行と成功の混同 | 確認・修正 | `latestFetchedCount`、`accumulatedArticleCount`、`lastAttemptAt`、`lastSuccessAt`、`lastError`を分離・永続化 | サービス再作成後の件数と成功・失敗状態 | 完全成功は情報源エラーなし、かつ保存完了と定義 |
| 不明な公開日を現在日時にする | 確認・修正 | 収集時に日付を捏造せず、SQLiteにNULL。既存の既知日付は欠落レスポンスで消さない。検索表示は`publicationDateKnown`で不明を区別 | 日付なしRSSのSQLite値を確認 | 日付なし記事のランキングは従来互換の初回発見日時を代替値に使う |
| UPSERTで`created_at`が更新される | 誤判定 | 元のUPDATE句に`created_at`はない。その仕様を変更しない | `articles-first-seen.test.ts`、候補更新テスト | なし |
| RSS/arXiv/GitHubとReaderの安全なHTTP取得 | 確認・修正 | 既存作業にあった`safe_fetch.ts`を再利用。接続時の全DNSアドレス検査、接続先固定、毎ホップの検証、回数・容量・全体時間制限、圧縮展開制限、Content-Type検証を共通化 | private DNS、混在DNS、危険なリダイレクト、ループ、遅延連鎖、巨大・chunked・圧縮レスポンス、中断、種類違い | ローカルHTTPサーバーとDNS差し替えで安全性を検証。実サイトの稼働状況・全フィードの互換性はネットワーク越しに巡回していない |
| colorのStored XSS | 再現・修正 | APIで色の文法を制限し、旧DBの危険な値もUIで描画しない。KJ色も同様に保護 | 不正colorは400、描画後に注入属性がないことを確認 | なし |
| 外部URL・タグ・IDのHTML/JS埋め込み | 確認・修正 | URLはHTTP(S)だけリンク化。動的なハンドラー引数はJSON文字列化と属性エスケープを分離。KJ名称変更はDOMイベントに移行 | 悪意あるURL/ID/HTMLの描画、実ハンドラー評価で注入コードが走らないことを確認 | 全UIの形式的なセキュリティ証明ではない |
| 収集記事と同名IDカードが混ざる | 再現・修正 | 保存済みカードによる本文上書きをカード検索だけに限定。形態素/N-gramの両トークンも引き継ぐ | 同名IDでも収集記事のタイトル・本文を維持 | なし |
| 収集記事に`cards_fts`のシグナルを融合する | 条件付き不具合・修正 | Hybridエンジンに検索コーパスを渡し、収集記事ではカードFTSを使用しない | Hybridの収集記事検索にカード由来`scoreSources`が入らないことを確認 | 収集記事用の新規FTS索引は追加しない。記事はBM25を使用 |
| 0件の登録情報源が管理対象から消える | 確認・修正 | 検索先一覧に設定済みRSS/arXiv/GitHubを0件でも含める。サイト管理は既存機構を維持 | 未収集RSSの一覧表示テスト、既存サイト管理テスト | ソース管理画面の大幅な刷新は対象外 |
| 検索条件が情報源変更で失われる | 既存設計を維持・検証 | 現行の保存済み検索・検索先選択を維持 | UI結合テスト、再読み込み後の条件復元E2E | なし |
| E2Eの候補保存が不安定 | 確認・修正 | ボタンの位置ではなく名前で選択。同一DB・候補fixtureを共有するため1 workerで実行し、前回の保存カードを明示的に解除 | Chromium E2E全件 | リトライによる失敗の隠蔽は追加していない |
| 重複排除込み性能ゲートの超過 | 実測・修正 | 集合サイズの上限と途中の最大一致数で、厳密Jaccard判定を早期終了。LSHの設定・候補生成・閾値は変更しない | 全列挙Jaccardとの200組×8閾値×両方向比較、既存85%再現率テスト、性能測定 | 実行環境によるレイテンシ変動は残る |
| 性能スクリプトが失敗時にも`ok: true` | 確認・修正 | `performanceFailures`に合わせて成功フラグを出力 | ベンチマークの出力と終了コードを確認 | なし |
| 減衰スイープの全実験値に幅のある窓を要求 | 検証契約の不整合・修正 | 各床の窓を実測から再計算して報告と照合。既定0.35の幅のある窓は引き続き必須。閾値やランキングパラメータは変更しない | 床0.4以上は幅0の観測結果も許容し、既定0.35は幅0.005を検証 | 実験値の全てが本番利用可能という意味ではない |

## 修正前後の証拠

最初に追加した8件の再現テストは、コード変更前に8件とも失敗した。単体・一括削除後の保存済み状態、DBにある記事のインポート漏れ、Readerのタイトル/URL不一致、409後のキャッシュ更新、全文保存失敗後の部分保存、本文取得経路の不一致、不正colorの受理をそれぞれ確認した。修正後はこれらが通過した。

初回実行はVitestの一時ファイルrenameがサンドボックスの`EPERM`で失敗し、テストは開始されなかった。通常実行環境で再実行して上記8件の失敗を確認した。これは製品の不具合とは区別する。

中間のテスト実行では、追加したテスト側の不備（`esc`の重複宣言、別eval間の`const api`参照、トークン未準備のHybrid入力）も検出・修正した。旧Readerテーブルへの列名なしINSERTは新スキーマに対応して明示列名へ変更した。最終結果だけでなく、これらの失敗も区別して記録する。

## 検証コマンド

実行ディレクトリはリポジトリルート。Windowsでは`npm.cmd`と`npx.cmd`を使用した。

```powershell
npx.cmd vitest run server.test.ts query_parser.test.ts articles-first-seen.test.ts tests --fileParallelism=false --reporter=default --reporter=json --outputFile=artifacts/static-review-tests.json
npx.cmd vitest run tests/static-review-regressions.test.ts tests/collector-review.test.ts tests/migration.test.ts tests/jaccard-threshold.test.ts tests/sites.test.ts tests/search_quality.test.ts --fileParallelism=false --reporter=default --reporter=json --outputFile=artifacts/static-review-final-focused-tests.json
npm.cmd run typecheck
npm.cmd run check:frontend
npm.cmd run build:frontend
npm.cmd run test:e2e
npm.cmd run evaluate:search
npm.cmd run benchmark
npm.cmd run benchmark:http
npm.cmd run check:openapi
npm.cmd run check:encoding
$env:DB_PATH = 'data/static-review-schema.db'
npm.cmd run verify:schema
npm.cmd run check:search-index
git diff --check
```

スキーマ確認は専用DBを使用。テストは既存のテスト用DBを使用し、利用中のカードDBへの移行を直接実行していない。実利用環境ではアプリ再起動時に`021_collection_reader_integrity`がトランザクションで適用される。

`npm run verify`一括実行、Dockerビルド、依存ライブラリの脆弱性監査は今回は実行していない。一括verify全体が通るという主張ではない。

## 検索品質・性能

検索品質ゲートは通過。今回の対応でBM25重み・時間減衰・評価の合否閾値は変更していない。

| スコープ | クエリ数 | P@1 | R-Precision | MRR | Recall@5 | nDCG@5 |
|---|---:|---:|---:|---:|---:|---:|
| ranking（診断） | 20 | 0.900 | 0.900 | 0.925 | 0.950 | 0.931 |
| endToEnd（ゲート） | 20 | 0.950 | 0.950 | 0.975 | 1.000 | 0.979 |
| real（ゲート） | 50 | 0.840 | 0.782 | 0.895 | 0.902 | 0.854 |

重複排除込み5,000件のスコープは、最適化前3,103ms / 3,410msで3,000msゲートを超過。厳密判定の早期終了後は2,674.641msとなり通過した。これは同一環境での実測であり、普遍的な速度保証や統計的な性能評価ではない。過去の保存済みベンチマーク（8月、別実行条件）との比較だけで今回の回帰原因を断定していない。

HTTP測定は初回104.071ms、warm平均11.120ms、候補API802.217ms、保存カード検索9.219msで既存ゲートを通過した。結果は`artifacts/benchmark-results.json`と`artifacts/benchmark-http-results.json`、検索品質は`artifacts/search-quality.json`に記録した。

## 変更ファイル

着手前からの変更が混在するため、以下は今回編集したファイルの一覧であり、作業コピー全体の差分一覧ではない。

- 記事識別・収集: `collector.ts`, `services/article_identity.ts`, `services/collector_service.ts`
- 永続化・移行: `db/migrate.ts`, `repositories/articles_repository.ts`, `repositories/cards_repository.ts`, `repositories/reader_texts_repository.ts`
- API: `routes/articles_routes.ts`, `routes/collect_routes.ts`, `routes/reader_routes.ts`, `routes/search_routes.ts`, `services/route_context.ts`, `services/http_service.ts`, `schemas/api_schemas.ts`
- 取得・検索: `services/safe_fetch.ts`, `services/reader_service.ts`, `search/search_engine.ts`, `bm25_engine.ts`
- 描画: `public/js/cards_ui.js`, `public/js/candidate_ui.js`, `public/js/kj_ui.js`, `public/js/search_workflow_ui.js`
- テスト: `tests/static-review-regressions.test.ts`, `tests/collector-review.test.ts`, `tests/jaccard-threshold.test.ts`, `tests/sites.test.ts`, `tests/search-workflow.test.ts`, `tests/search_quality.test.ts`, `playwright.config.ts`, `e2e/core-flows.spec.ts`, `e2e/search-workflow.spec.ts`
- 検証・記録: `scripts/benchmark.ts`, `docs/benchmark.md`, 本書
- 再生成結果: `artifacts/static-review-tests.json`, `artifacts/static-review-final-focused-tests.json`, `artifacts/e2e-tests.json`, `artifacts/benchmark-results.json`, `artifacts/benchmark-http-results.json`, `artifacts/search-quality.json`, `artifacts/ranking-engine-quality.json`, `artifacts/end-to-end-query-quality.json`, `artifacts/real-search-quality.json`

`services/safe_fetch.ts`など着手時に未追跡だった既存作業も再利用・編集している。今回その機能一式を新規作成したという意味ではない。

## 実行結果

| 検証 | 最終結果 |
|---|---|
| 全単体・API・受け入れテスト | 36ファイル、299件成功、失敗0、終了コード0 |
| 修正対象の追加再確認 | 6ファイル、66件成功、失敗0、終了コード0（全体テストとの重複を含むため加算しない） |
| Chromium E2E | 10件成功、失敗0、終了コード0 |
| TypeScript型チェック・既存JS構文確認・frontendビルド | 全て成功、各終了コード0 |
| 検索品質評価 | 成功、終了コード0。上記3スコープの結果を記録 |
| 検索・HTTPベンチマーク | 最適化後は両方成功、各終了コード0。閾値変更なし |
| OpenAPI・文字コード確認 | 両方成功、各終了コード0 |
| 専用DBでのスキーマ・FTS索引確認 | 両方成功、外部キー違反0、integrity=ok |
| `git diff --check` | 成功。既存ファイルのCRLF→LF警告はあるが空白エラーなし |

全体テストの結果は`artifacts/static-review-tests.json`に保存した。追加再確認の66件は、その後の全299件の実行にも含まれている。
