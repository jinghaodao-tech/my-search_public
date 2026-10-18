# サイト登録・記事収集・検索の統合修正

検証日: 2026-10-18 (Asia/Tokyo)

## 受け入れ結果

変更していない `notes/site-integration-probes.ts` の診断は、**修正前2/11通過・9件未達から、修正後11/11通過・未達0件**になった。

- 修正前: `artifacts/site-integration-before.json`
- 最新診断: `artifacts/site-integration-probes.json`
- 全Vitest: `artifacts/site-integration-regression-tests.json`
- E2E: `artifacts/e2e-tests.json`

既存の未コミット変更は保持した。統合修正の初回報告時にはcommit・push・PR作成は行っていない。実利用DBを検証には使っていない。後続のcommit依頼に伴う追加確認は末尾を参照。

## 診断と修正の対応

| 診断 | 修正前 | 修正内容 | 修正後 |
|---|---|---|---|
| registration-to-card | 通過 | 既存の登録・検索・候補保存の流れを維持 | 通過 |
| cross-source-fulltext | 未達 | 本文の種類と取得元の更新日時によって採用本文を決定 | 通過 |
| cross-source-search | 未達 | 複数所属を保存し、検索フィルター・件数・検索先を所属ベースに変更 | 通過 |
| query-order-id-join | 未達 | 共通URL識別規則と保存処理が返す正本IDを使用 | 通過 |
| site-save-atomicity | 未達 | 記事・所属・別名・移動・チェックポイントを同期トランザクションで確定 | 通過 |
| site-job-failure-status | 未達 | 初回・手動・定期ジョブで同じ `assessSiteRun` を使用 | 通過 |
| site-unknown-date | 未達 | 公開日不明はNULL。更新日時と発見日時を公開日へ代入しない | 通過 |
| site-concurrent-sync | 未達 | サイトIDごとの共有Promiseで同時実行を合流 | 通過 |
| site-redirect-scope | 未達 | 開始・リダイレクト・応答・canonical・保存URLの範囲を検査 | 通過 |
| site-http-content-type | 未達 | ページ・API・フィード・サイトマップのメディアタイプを実際に検査 | 通過 |
| site-http-safety | 通過 | 共通HTTPのDNS/IP・容量・タイムアウト制限を維持 | 通過 |

## 変更ファイルと責務

| ファイル | 関数・変更 |
|---|---|
| `services/article_identity.ts` | `articleIdentityKey`: クエリ順序・追跡項目・フラグメントの扱いを集約。歴史的なhttp/https・www・末尾スラッシュの識別互換を維持 |
| `services/site_parsing.ts` | `normalizeArticleUrl` / `articleKey`: 共通規則に委譲。意味のある `ref` 等を独自に削除しない |
| `collector.ts` | RSSのURL由来識別も共通化。RSS/arXiv/GitHub本文は抜粋として明示 |
| `bm25_engine.ts` | `Article` に所属・本文種別・取得元更新日時の内部型を追加 |
| `repositories/articles_repository.ts` | `saveArticlesToDb` が入力ID→正本IDを返し、所属・本文種類・トークンを原子的に更新。`loadArticlesFromDb` は所属を一括取得。統計は情報源種別ごとに記事を重複排除 |
| `repositories/site_sources_repository.ts` | 正本IDで所属を更新。サイト解除は他の所属・カード・追跡項目だけ違う手動保存URLを保護。件数は記事ID単位 |
| `routes/search_routes.ts` | 検索・保存済み検索の新着・検索先・全文表示・総件数に複数所属を反映。検索結果は記事単位で一件 |
| `db/migrate.ts` / `db/migrate_site_integration.ts` | `022_site_article_integration`、本文種別・所属・修復ログ・記事外部キー |
| `services/site_collector.ts` | `syncSite` の共有排他、非同期取得/トークン生成と同期コミットの分離、権限変更/サイト解除時の保存拒否、失敗後の再試行、未知日付、`assessSiteRun` |
| `services/safe_fetch.ts` | リクエストごとの `validateUrl` を接続前とリダイレクト各段階に適用 |
| `services/site_adapters.ts` | `typedFetch` を通じてJSON・XML・HTML形式と発見用ホスト範囲を検査 |
| `services/discover_service.ts` | フィードの公開日とAtom更新日時を分離 |
| `services/job_service.ts` | 任意の結果判定を追加。例外だけでなく結果の失敗状態も永続化 |
| `routes/site_routes.ts` / `app.ts` | 初回・手動・定期ジョブを共通結果判定とサイト排他へ接続 |
| `public/js/site_sources_ui.js` | 部分成功は警告表示。完全成功と混同しない |
| `scripts/migrate_db.ts` / `scripts/verify_schema.ts` | 修復/隔離件数と理由、記事外部キー、本文・所属スキーマを報告 |
| `tests/site-integration.test.ts` | 20件の回帰。変更していない11診断を別プロセスで実行するため、既存のacceptance:test/CIにも含まれる |
| `tests/static-review-regressions.test.ts` | 旧DBテストを021と022の連続移行まで拡張 |
| この報告書 / `docs/site-integration-review-2026-10-18.md` | 修正前記録を残し、最新結果との区別を明記 |

ベンチマーク・検索品質・E2Eの既存JSON成果物は再実行で更新。ベンチマークから生成される `docs/benchmark.md` も更新される。

## 本文と日時の規則

- 新規の抜粋は `excerpt`、取得許可のあるサイト全文は `fulltext` として保存する。
- 全文に抜粋を重ねても、タイトル・本文・要約・タグ・権威値・トークンは維持する。文字数で優劣を決めない。
- 全文から全文への更新は、双方の更新日時が分かれば古い方を拒否する。新しい全文が短くても採用する。
- 更新日時が不明な全文同士は、最後に取得した全文を採用する。元サイトが更新日時を出さなければ新旧を証明できない。
- Reader本文は `article_reader_content`、保存カード/メモは既存のカード・Reader保存テーブルに残す。外部収集では書き換えない。記事タイトル変更時はReaderの検索トークンを無効化し、次回必要時に再計算する。
- 公開日不明はNULL。取得元更新日は `source_updated_at`、発見日は `first_seen_at`、取得日は `last_fetched_at` に分離する。
- 検索の互換性のため公開日不明の記事は発見日を順位計算へ利用できるが、`publicationDateKnown: false` を維持する。読み出した記事の再保存でも発見日を公開日にしない。
- 旧記事に過去の処理が架空の公開日を保存したかは確実に判別できないため、推測による一括消去はしていない。

## DB移行と失敗時

`022_site_article_integration` は記事IDやカードを再生成しない。

1. `articles.body_kind` / `source_updated_at` を追加する。
2. 汎用の `article_sources` は記事と収集元の所属、既存 `site_articles` はサイト固有の更新・HTTP・移動状態を持つ。役割を分ける。
3. 孤立参照は既存ID、ID別名、一意なURL一致の順で解決する。解決/隔離した行・理由・元の内容を `site_article_repairs` に残す。
4. URL一致が複数ある場合は推測で結合しない。解決不能・サイト不在の関連も隔離する。既存の有効記事自体は削除しない。
5. 関連表をトランザクション内で移行し、記事への `ON DELETE CASCADE` と索引を追加する。
6. 所属と本文の種類を安全に分かる範囲で補完する。単に本文が長いことを全文の根拠にしない。

サイト同期中はHTTP・形態素解析をトランザクション外で終えてから、正本ID解決と全DB変更を同期的にコミットする。失敗すると記事、所属、ID別名、URL移動、成功チェックポイントをまとめて戻す。失敗状態はロールバック後に別途記録する。部分成功では保存できた記事を残すが `last_success_at` を進めず、失敗記事を再試行できる。

`db:migrate` と `verify:schema` は修復理由別件数を表示する。隔離ログには元URLを含むため、実データのDBやログを公開しない。

## HTTP境界

- 記事: 登録済みの記事範囲を開始URL・各リダイレクト・最終応答・canonical・保存前URLで確認する。
- 発見リソース: 登録済みホスト上の設定済み/発見済みAPI・フィード・サイトマップ・robotsを取得できる。記事パス外のAPI等は許可するが、同期時にリダイレクトでリソースのパスまで変えることは許可しない（末尾スラッシュ差を除く）。
- HTML/XHTML、JSONと`+json`、XML/RSS/Atomと`+xml`をそれぞれ検査し、パラメータ付き・大文字小文字も扱う。gzipサイトマップは形式と展開サイズを制限する。robotsはtext/plain。
- 登録検出中に転送先を表示して確認することと、登録後の記事の範囲を勝手に拡張することは別の処理。
- 公開IPへの転送でも範囲外なら拒否する。SSRF/DNS・容量・タイムアウトの制限は共通HTTP取得をそのまま使う。

## テスト

| 実行 | 結果 |
|---|---|
| `npx.cmd tsx notes/site-integration-probes.ts` | 11/11通過、未達0 |
| `npx.cmd vitest run server.test.ts query_parser.test.ts articles-first-seen.test.ts tests --fileParallelism=false --reporter=default --reporter=json --outputFile=artifacts/site-integration-regression-tests.json` | 37ファイル・319件成功、失敗0（追加20件を含む）。JSONへ保存 |
| `npm.cmd run typecheck` | 成功 |
| `npm.cmd run check:frontend` / `npm.cmd run build:frontend` | 成功 |
| `npm.cmd run test:e2e` | Chromium 10/10成功、失敗0 |
| `npm.cmd run evaluate:search` | 既存品質ゲート成功、閾値変更なし |
| `npm.cmd run benchmark` / `npm.cmd run benchmark:http` | 既存性能ゲート成功、閾値変更なし |
| `npm.cmd run verify:schema` | 専用一時DB、integrity=ok、外部キー違反0、記事FKあり |
| `npm.cmd run check:search-index` | 同じ専用一時DB、索引エラー0 |
| `git diff --check` | 成功（既存CRLFファイルのLF正規化予告あり） |
| `npm.cmd run check:encoding` | 成功 |

スキーマ/索引コマンドには `DB_PATH=%TEMP%/my-search-site-integration-verification-20261018.db` と `NODE_ENV=test` を指定した。このコマンド用DBは空であり、データ入り旧DB・別名/URL修復・カード/Reader保持・FK連鎖は回帰テスト内の専用DBで検証した。

Vitestをファイル指定なしで実行するとPlaywright専用ファイルまで収集するため、その試行は中断し、既存のnpmスクリプトと同じVitest対象を明示して再実行した。失敗をスキップしたのではなく、E2Eは専用ランナーで10件実行した。

## 検索品質と性能

検索指標は修正前成果物との比較で全値が同一だった。

| スコープ | クエリ | P@1 前→後 | R-Precision 前→後 | Recall@5 前→後 | nDCG@5 前→後 |
|---|---:|---|---|---|---|
| ranking（診断） | 20 | 0.900→0.900 | 0.900→0.900 | 0.950→0.950 | 0.931→0.931 |
| endToEnd（ゲート） | 20 | 0.950→0.950 | 0.950→0.950 | 1.000→1.000 | 0.979→0.979 |
| real（ゲート） | 50 | 0.840→0.840 | 0.782→0.782 | 0.902→0.902 | 0.854→0.854 |

| 性能スコープ | 前 (ms) | 後 (ms) | 既存上限 (ms) |
|---|---:|---:|---:|
| ranking-only / 10,000文書 | 177.424 | 120.386 | 500 |
| production-like / 5,000文書 | 2674.641 | 1809.853 | 3000 |
| end-to-end-pipeline / 1,000文書 | 45.440 | 27.316 | 1000 |
| 初回HTTP | 104.071 | 92.792 | 2000 |
| ウォームHTTP | 11.120 | 9.972 | 250 |
| 候補検索HTTP | 802.217 | 655.748 | 3000 |
| 保存カード検索HTTP | 9.219 | 8.500 | 250 |

前の測定は同日19:00〜19:04、後の測定は19:39〜19:40の別実行。速度差を今回の修正の効果と断定する比較ではない。既存ゲートで性能回帰を検出しなかったことを確認した。

修正前の検索/性能成果物は `artifacts/site-integration-before-search-quality.json`、`site-integration-before-benchmark-results.json`、`site-integration-before-benchmark-http-results.json` として保存した。

## 残る制約

- 外部の実サイトへの接続試験はしていない。HTTPの実接続はローカルテストサーバー、サイトの内容は固定フィクスチャ/注入トランスポートで検証した。
- 排他は仕様どおり単一プロセス内。複数アプリプロセスを起動する運用には分散排他が必要だが今回は追加していない。
- 登録外のCDN上の発見APIや、同期中に別パスへ転送されるフィードは自動許可しない。対応には登録範囲の明示的な再確認が必要。
- 更新日時が提供されない全文の新旧、過去に偽造保存された公開日、記事がHTTP/HTTPS等で実際に異なるサイトの識別は、この互換方針だけでは保証できない。
- 実利用DBへの適用と稼働中サーバーの再起動はしていない。次回のアプリ起動時に既存の起動時マイグレーション経路で022が適用される。

今回要求された11診断と境界条件の修正を対象とし、新規検索エンジン、記事FTS5、AI分類、分散クローラー等は追加していない。

## Commit前の追加確認

その後、ユーザーから「現在の未コミット変更をすべて」commit・pushする指示を受け、別作業で追加されていた機能・配布設定・資料も含む状態を再検証した。

- 全Vitest: **41ファイル・340件成功、未処理エラー0件**。最新JSONは `artifacts/site-integration-regression-tests.json`。上記319件は統合修正の初回検証時点の結果。
- E2E: Chromium **10件成功**。型チェック、本番ビルド、フロントエンドのチェック/ビルド、文字コード、OpenAPI、検証成果物チェックも成功。
- 最初の全体再実行ではテスト本体340件は成功したが、画面テストの終了時に未処理エラーが1件発生した。`tests/search-workflow-ui.test.ts` がHTTP応答後の処理を待ってからJSDOMを閉じるように修正し、対象テスト3回連続と全体再実行の成功を確認した。
- 公開対象の差分にDB・秘密鍵・実環境の`.env`は含めていない。既知の認証情報形式の検査でも該当なし。この検査だけで秘密情報が存在しないことを証明するものではない。
