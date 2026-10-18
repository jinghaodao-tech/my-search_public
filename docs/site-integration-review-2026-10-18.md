# サイト登録・収集と既存処理の統合確認

確認日: 2026-10-18 (Asia/Tokyo)

追記: この文書は**修正前の診断記録**です。その後の修正と再検証は [統合修正報告](site-integration-fixes-2026-10-18.md) を参照してください。

## 結論

**正常な単一情報源の経路は動作しているが、正しく統合し終わった状態ではない。**

APIによるサイト登録、初回収集ジョブ、SQLite保存、日本語/英語検索、候補保存、重複保存拒否、カード削除後の再保存は通過した。一方、情報源が重なる場合と障害・競合時の統合診断では不整合が再現した。

今回は確認依頼として、製品コードは修正していない。診断用スクリプトとこの報告書のみ追加し、前回の報告書に補足リンクを入れた。commit、push、PR作成は行っていない。

## 結果

| 実行 | 結果 | 終了コード |
|---|---|---:|
| 既存の関連回帰テスト | 4ファイル、66件成功、失敗0 | 0 |
| 今回の専用統合診断 | 11チェック中2チェック通過、9チェック未達 | 1 |
| TypeScript型チェック | 成功 | 0 |

この11チェックは、疑わしい境界を意図的に選んだ診断であり、製品全体の成功率や検索精度を表す標本ではない。通常テストと同じ問題を複数の観点から確認しているものもある。

修正前の診断結果: `artifacts/site-integration-before.json`。`artifacts/site-integration-probes.json` は再実行で更新される最新結果です。

既存回帰結果: `artifacts/site-integration-baseline-tests.json`

## 確認できた正常経路

- サイト登録APIが201を返し、初回ジョブが実行される。
- 収集記事に形態素解析・N-gram両方のトークンが保存される。
- 登録サイトを指定した日本語・英語検索で収集記事がヒットする。
- 候補保存は201、同じ候補の再保存は409。カード削除後は201で再保存できる。
- サイトページ取得から共通HTTP処理を通して、private URLは`blocked`、巨大レスポンスは`too_large`として拒否される。

## 検出した不整合

### P1: 同一記事のRSS再収集でサイト全文と所属が失われる

診断: `cross-source-fulltext`、`cross-source-search`。

登録サイトで取得した全文358文字が、同じURLのRSS再収集後に`RSS excerpt only`へ置き換わった。記事IDは維持されるが、`source`も`site:<id>`から`rss:Integration`へ変わる。

`repositories/articles_repository.ts:231`、`:233`のUPSERTが本文と情報源を無条件更新するため。サイトとの関連行は残る一方、`routes/search_routes.ts:54`の絞り込みは`articles.source`だけを見るため、登録サイトを選ぶと検索対象0件になる。検索先一覧も「記事0件、本文1件」という矛盾した表示になる（`:175`）。

保存済みカードやReader専用テーブルにあるコピーまで消えたという意味ではない。**サイト収集で`articles.body`に保存した全文**の問題。

必要な対応: 記事の内容品質と取得経路を分離し、短い抜粋で取得済み全文を上書きしない。複数情報源への所属を維持し、サイト検索・件数・削除の判断もその関連に基づける。

### P1: URL正規化の違いで存在しない記事IDを参照する

診断: `query-order-id-join`。

同じページの`?a=1&b=2`と`?b=2&a=1`を1回の収集に含めると、サイト側は2記事としてIDを生成する。一方、共通リポジトリはクエリ順序を正規化して1記事へ重複排除する。その後サイト側は両方のIDを`site_articles`へ記録し、**存在しない記事IDへの参照が1件残った**。収集結果は`added: 2`、`status: ok`となった。

原因は`services/site_parsing.ts:124`の`articleKey`と`services/article_identity.ts`の正規化ルールの差、および`services/site_collector.ts:256`が保存後の実際のIDを確認せず`:257`で関連を記録すること。

`db/migrate.ts:116`の`site_articles.article_id`には外部キーがないため、この不整合があっても`PRAGMA foreign_key_check`は空配列だった。

必要な対応: 正規化方針を共通化し、実際に保存された正本IDを関連テーブルへ渡す。既存の不整合行を安全に修復したうえで参照整合性を担保する。

### P1: 記事本体とサイト索引の保存が原子的ではない

診断: `site-save-atomicity`。

`site_articles`へのINSERTにABORTトリガーで障害を注入すると、収集結果は`status: error`になったが、記事本体はSQLiteに残り、サイト索引は0件だった。

`services/site_collector.ts:256`の本文保存と`:257`の関連保存が別トランザクションだから。さらにURL移動や確認状態の更新も、取得途中に実行されている。

必要な対応: HTTP取得・トークン準備とDB確定を分離し、記事本体・サイト関連・URL移動など整合性が必要な変更を共通トランザクションで確定する。

### P1: SQLite保存失敗をジョブが成功として記録する

診断: `site-job-failure-status`。

APIからサイトを登録し、記事INSERTで障害を注入したところ、サイトは`status: error`、ジョブ内の結果も`status: error`だったが、**ジョブ本体は`succeeded`**だった。

`syncSite`が例外を結果オブジェクトへ変換し、`routes/site_routes.ts:142`と`:144`のハンドラーがそのまま返すため。`services/job_service.ts:31`はPromiseがresolveすると`:32`で成功とする。手動更新にも同じ経路がある（`routes/site_routes.ts:163`）。

必要な対応: エラー結果をジョブ失敗へ伝える契約を明示する。部分成功と完全失敗は分ける。登録そのものを取り消す必要はないが、収集ジョブを成功と偽らない。

### P1: 公開サイト間のリダイレクトで登録範囲外の本文を保存する

診断: `site-redirect-scope`。

登録サイトの記事が別の公開ホストへ転送された応答を模擬すると、別ホストの本文を元サイトのURL・情報源として保存し、`status: ok`になった。

`fetchPageMeta`は最終URLを返す（`services/site_collector.ts:64`）が、呼び出し側（`:217`）が最終URLの登録範囲を確認せず、canonicalだけを確認している（`:227`）。共通HTTP処理はprivate宛を拒否するが、公開ホスト間の移動自体は許可する。

これはprivateネットワークへのSSRFが再発したという指摘ではない。**登録範囲と本文取得許可の境界**の問題。

必要な対応: サイト収集のHTTP経路にホスト・範囲制約を渡し、リダイレクトの各段階と保存前に確認する。API・robots等に必要な許可範囲と記事本文の許可範囲は区別する。

### P2: サイト経路では不明な公開日を現在日時にしている

診断: `site-unknown-date`。

日付のないRSSを登録サイトのfeedアダプターで収集すると、`published_at`には検証時点の現在日時が保存された。

`services/site_collector.ts:116`に`published ? new Date(published) : new Date()`が残っている。共通RSSコレクターの修正は、この別経路には適用されていない。

必要な対応: 不明な日付をNULLとして扱い、更新日時・発見日時・公開日時の意味を混同しない。

### P2: 同一サイトの手動・定期同期に共有ロックがない

診断: `site-concurrent-sync`。

同一サイトの`syncSite`を同時に呼び出すと、同じフィードの取得が2件同時進行し、両方とも`ok`で完了した。

`services/site_collector.ts:151`にはサイト単位の実行ロックがなく、`syncDueSites`（`:302`）も手動実行のロックを共有していない。APIの`checking`判定と、サイトスケジューラー全体の`running`は、全呼び出し元を覆う排他ではない。前回修正したRSS/arXiv/GitHub用の収集ロックとは別経路である。

必要な対応: サイトID単位の共有排他を収集サービス側へ置き、API・初回ジョブ・定期実行から共通利用する。

### P2: サイト側は共通HTTP処理のContent-Type検証を有効化していない

診断: `site-http-content-type`。

実際のローカルHTTPサーバーから`application/json`を返すと、サイトページのメタデータ取得は成功として受け入れ、空のメタデータを返した。

`services/site_collector.ts:53`は`Accept`ヘッダーだけ指定しており、共通HTTP処理の`allowedContentTypes`を渡していない。Reader本体の取得ではこの検証を有効にしているため、統合が揃っていない。

必要な対応: ページ・JSON API・XML/フィードそれぞれの経路で、必要なレスポンス種別を明示して検証する。Content-Typeの違いだけでスクリプトが実行されたという結果ではない。

## 再現方法

```powershell
npx.cmd vitest run tests/sites.test.ts tests/static-review-regressions.test.ts tests/collector-review.test.ts tests/search-workflow.test.ts --fileParallelism=false --reporter=default --reporter=json --outputFile=artifacts/site-integration-baseline-tests.json
npx.cmd tsx notes/site-integration-probes.ts
npm.cmd run typecheck
```

診断スクリプトは`tests/helpers.ts`の隔離されたテストDBを使用し、通常の受け入れテストには含めていない。終了コード1は上記の未達条件を再現した結果であり、スクリプト起動エラーではない。

サイト応答は決定的なモックで検証し、HTTPの容量・Content-Typeはローカルサーバーで確認した。外部サイト巡回や実利用DBの更新は行っていない。公開ホスト間リダイレクトは共通fetchインターフェースが返す最終URLを模擬した境界テストであり、特定の実サイトでのリダイレクトを観測したものではない。

## 修正の順序

1. 取得済み全文・複数情報源所属の保持と、正本記事IDへの関連付け。
2. 記事本体・サイト索引の原子的保存、ジョブ失敗の伝播。
3. 登録範囲を越えるリダイレクトの制限。
4. サイト単位の実行ロック、日付の意味、Content-Type検証の統一。

前回の299テスト成功は既存テスト範囲での証拠であり、上記の統合境界まで正しいことの証明にはなっていなかった。今回の診断は、その不足を明示するためのもの。
