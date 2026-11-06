# my-search 状況適応型自動化：実装・検証報告

更新日：2026-11-06
基準：`main` / 公開基準 `f8b837c40d509dc120fded98fc7657a262a89e6f`

## A. 結論と差分監査

F1〜F6の既存実装をつなぎ、不足していた本文位置の曖昧性処理、収集記事検索エラー時の案内、引用転送時の競合防止、同意ベースのローカル計測などを補いました。追加監査では、ブラウザーAIアダプターの実体がTypeScript契約から外れて型検査されていない点も確認し、classic-script UIのAPI境界を共有型に結び、ランタイム契約テストを追加しました。さらに、検索語AI候補の中断・古い結果の適用防止、F2表示ログの重複修正、F2の検索語AI候補生成に対する同意時のみの処理状況・所要時間記録を追加しました。2026-11-06の全体検証はVitest 61ファイル・470成功・2スキップ、Chromium E2E 29成功・2スキップ、型検査・フロントエンドビルド・検査が通過しています。最後の計測テスト安定化後も関連Vitest 8ファイル・92成功・1スキップとE2E 29成功・2スキップを再確認しました。

これは**実装・合成/隔離テストの完了**です。本人や他の利用者を対象にした比較試験、利用者利益、各機能が総作業負担を減らすことは実証していません。実DBの内容、既存カード・メモ・Reader本文、検索ランキング既定値は変更していません。

| 領域 | 既存実装の再利用 | 今回の連結・変更 | 判定 |
|---|---|---|---|
| 検索／Reader | 保存カード検索、収集記事検索、検索スニペット、Reader段落、保存検索 | スニペットと保存段落の一意・複数・不一致表示、一覧保持 | 連結・補完 |
| 検索失敗 | 保存カード0件案内、検索対象・スコープ表示、検索語展開 | 保存カード/APIエラーと収集検索/APIエラーを0件と区別し、条件を保持した再試行導線 | 連結・補完 |
| 引用／メモ | Reader選択、既存メモ、記事export、本文ハッシュ | 別カードメモへ出典・位置付きで追記。更新時はSQLite transaction内でsource/target本文の期待値を再確認 | 新規連携 |
| 再開 | Readerセッション、ブラウザー内Reader下書き、保存検索 | F4設定との連携、古い本文位置を再確認、下書き明示復元/破棄 | 連結・補完 |
| 記事内ツール | Reader Toolsの型・式・範囲・出典検証 | Chrome Prompt APIの候補を一時プレビューへつなぎ、保存前の検証を維持 | 連結・実験 |
| 関連箇所 | 目的語のルール抽出、AI根拠抽出、引用照合 | ルール結果を先に表示し、AI実行は明示操作後。生成物と原文引用を区別 | 連結・補完 |
| AI境界 | Chrome内蔵AI、設定済みサーバーAI、試験モック | 能力別ブラウザーadapterと能力・入出力・出典の型を追加し、利用中のJS adapterを共有TS型に接続 | UIの呼出し境界は型検査済み。低レベルprovider factoryは今後のadapter追加用で、現行各engineの実装はブラウザーadapter内で選択 |
| 研究計測 | 保存記事再発見の同意付き記録（別機能） | 状況別機能について初期OFFの同意、ローカルイベント保存、JSON出力・削除 | 新規 |

主要追加・変更ファイル：`public/app.js`、`public/js/features_ui.js`、`public/js/bm25_ui.js`、`public/js/local_ai.js`、`public/js/contextual_automation.js`、`public/js/contextual_ai_provider.js`、`public/js/contextual_study.js`、`public/js/search_screen_ui.js`、`public/js/search_workflow_ui.js`、`public/js/reader_ui.js`、`public/index.html`、`repositories/cards_repository.ts`、`routes/reader_routes.ts`、`services/contextual_ai_provider.ts`、`services/http_service.ts`、`e2e/contextual-automation.spec.ts`、`tests/contextual_automation.test.ts`、`tests/contextual_ai_provider.test.ts`、`tests/contextual_browser_adapter.test.ts`、`tests/contextual_study.test.ts`、`tests/local_ai.test.ts`、`tests/cards.test.ts`、`tests/reader.test.ts`。

## B. 研究根拠と適用範囲

以下の「観測」は各原著の対象・条件内での結果です。my-searchへの適用は設計判断または仮説であり、研究結果の再現・有効性の証明ではありません。

| 研究 | 原著で報告された結果 | my-searchでの扱いと限界 |
|---|---|---|
| Quinn & Zhai, CHI 2016, [A Cost–Benefit Study of Text Entry Suggestion Interaction](https://research.google/pubs/a-costbenefit-study-of-text-entry-suggestion-interaction/) | 予測入力候補を積極的に提示するとキー操作は減った一方、候補への注意・評価コストにより平均入力時間が悪化した条件が報告された。 | 提示数やクリック削減だけで良し悪しを判断しない。入力候補の実験を検索・ReaderのUIへ直接一般化しない。 |
| Iqbal & Bailey, CHI 2008, [Effects of Intelligent Notification Management](https://interruptions.net/literature/Iqbal-CHI08.pdf) | 特定のプログラミング/図編集タスクで区切りを検出し、即時通知に対して区切りでの通知が不満・反応時間を改善した条件が報告された。検出精度と通知を遅らせるコストもある。 | 検索結果内の非モーダル操作は割込み通知と同一でない。任意のAI提示タイミングが最適とは結論せず、後続比較で無視率・遅延・総時間を測る。 |
| Findlater & McGrenere, CHI 2004, [A Comparison of Static, Adaptive, and Adaptable Menus](https://www.cs.ubc.ca/labs/edapt/papers/findlater2004.pdf) | 27人、分割メニューの実験では静的メニューが適応型より速く、利用者調整型が一部条件で適応型より速かった。過半数は調整可能UIを好んだ。 | 固定位置やユーザー制御を選択肢として残す理由にはなるが、記事検索アプリ全体で適応UIが劣る根拠にはしない。 |
| Feild, White & Fu, CHI 2013, [Supporting Orientation During Search Result Examination](https://www.microsoft.com/en-us/research/publication/supporting-orientation-search-result-examination/) | clickable snippetsを、検索結果上の他の向き付け方法と比較した研究で、参加者の選好と検索の有効性・効率の改善を報告した。 | スニペットから保存本文へ移る導線の根拠。ただし、本文版差や一致曖昧性の安全な扱いは本研究の主題でなく、my-search側で個別に検証する。 |
| Roy et al., CHIIR 2021, [Note the Highlight](https://chauff.github.io/documents/publications/CHIIR2021-Roy.pdf) | 学習目的Web検索の4条件・有効参加者115人で、highlight/noteは受容的語彙課題の学習を改善しなかった。片方のみの条件では別の記述式成果に差があり、両方提供した条件では有意な学習効果がなかった。 | 引用・メモ機能の存在や統合自体を成果と見なさない。対象タスク、使われ方、作業コストをmy-searchで別途比較する。 |
| Whittaker et al., CHI 2011, [Am I Wasting My Time Organizing Email?](https://doi.org/10.1145/1978942.1979457) | 345人・8万5千件超のメール再発見行動を分析し、複雑な事前フォルダー整理より検索・スレッドなどの事後的アクセスが有効だったと報告した。 | 保存記事の再発見を重視する背景になるが、メールの結果を記事保存・整理行動へ直接移さない。 |
| Buçinca et al., CHI 2021, [To Trust or to Think](https://www.iis.seas.harvard.edu/papers/2021/bucinca2021trust.shtml) | AI支援意思決定の実験（N=199）で、認知的forcing介入は単純な説明AIより過信を下げたが、主観評価とのトレードオフがあった。 | AI要点の出典表示は検証可能性のために行うが、「説明を増やすほどよい」「人が必ず検証する」とは仮定しない。 |
| Parasuraman, Sheridan & Wickens, 2000, [A Model for Types and Levels of Human Interaction with Automation](https://www.cs.uml.edu/~holly/91.550/papers/sheridan-autonomy.pdf) | 情報取得・分析・判断/行動選択・実行の機能と自動化レベルを分け、人的成果、信頼性、結果コストで評価する枠組みを提示した。特定製品に最適な自動化率を定める研究ではない。 | 状況検出・表示・AI候補生成・データ変更を分離する設計枠として使用。現在の水準が最適とは扱わない。 |

今回の実装判断は、低リスク処理は明示的な状況判定で操作候補を出し、本文・メモの変更は利用者操作後に行い、AIは候補生成だけに限定することです。これは本製品の安全・操作性に基づく暫定設計です。実際に総負担を減らすという予測は未検証です。

## C. F1〜F6の実装

共通状態は `unavailable / ineligible / eligible / active / suppressed`。機能フラグはブラウザーのlocalStorageに保存されます。初期値はF1〜F4/F6がON、実験的なF5がOFFです。機能停止は候補UIを隠し、利用者データを削除しません。AI実行とは独立しており、F5/F6のAI処理は明示操作後にのみ始まります。状態変化に応じて開いている補助UIを閉じる処理は追加していません。

| 機能 | 発動・操作 | AI／再利用 | 停止・失敗時と確認 | 状態 |
|---|---|---|---|---|
| F1 本文位置 | 保存カードまたは検索記事に抜粋があり、該当本文へ移動ボタンを表示。抜粋とReader本文の一意一致なら移動・短時間強調。複数一致は段落選択、ゼロ一致は本文を開いたまま通常探索。 | AIなし。既存Reader・段落・スニペット利用。 | F1をOFFにすると補助ボタンを出さない。検索条件・結果一覧は維持。保存本文版の不一致・未取得時に誤ジャンプしない。利用者が候補を押す。 | 実装・E2E検証済み |
| F2 検索失敗 | 0件、保存カード検索API失敗、収集記事検索API失敗を区別。エラー時には0件と断定せず、検索先/条件確認と同条件再試行を表示。閉じた検索条件の案内は同じ条件ではセッション中に抑制。 | 既存スコープ/対象情報・検索語操作を利用。0件時の自動AI呼出しなし。 | F2 OFF時は案内を出さず、検索結果/エラー応答は維持。再試行は利用者が押す。 | 実装・E2E検証済み |
| F3 引用転送 | 保存済みReaderで文章を選択し、保存先カードを選んで「出典付きで追加」。既存メモへ引用・source ID/URL・本文ハッシュ・段落位置を追記。 | AIなし。既存Reader選択・カード・メモ・Markdown export利用。 | 更新リクエスト中にsource/target本文が変わっていればSQLite transactionで競合扱いにし、誤追記を防止。引用元本文の変更/位置曖昧は出典リンクで黙って別箇所へ移動しない。 | 実装・E2E/APIテスト済み |
| F4 再開 | Readerの最後のカード/URL・段落位置を自動復元。下書きは対象Readerが開かれたとき復元/破棄を提示し、セッション復元中は既存自動下書き復元を維持。保存検索は既存の選択操作で手動復元。 | AIなし。既存localStorageのReaderセッション・下書きと保存検索を利用。 | F4 OFF時はReaderセッション自動復元・下書き案内を停止。本文位置は段落fingerprint一致時だけ復元し、変化時は先頭表示と説明。下書きの明示破棄でだけ下書きを削除。保存検索の手動復元は既存機能として継続。 | 実装。追加E2Eで下書き復元/破棄、既存E2Eでreload後のカード/位置復元・破損/期限切れ/本文変更を確認 |
| F5 記事内道具 | 数値を含む同一本文段落を選択した時に提案操作を表示。利用者が選んだ時だけChrome内蔵Prompt APIで型付き計算候補を生成し、サーバーで式・引用・単位・入力範囲を検証して一時プレビュー。 | ローカルChrome AI。既存Reader Tools validator/calculatorを再利用。提案は永続化しない。 | 実験フラグ初期OFF。AI利用不可/未対応/キャンセル/検証失敗時は本文・保存状態を維持。式の意味・単位の整合性は未検証と表示。破棄は明示操作。 | 実装・モックAIを使ったUI/隔離DB E2E検証済み。実Chromeモデルの生成品質は未検証 |
| F6 要点・関連箇所 | 検索結果からReaderへ進む操作で目的語を事前入力。まず語句ベースの原文抜粋を表示。利用者が要点生成を押すと、選択中engineに応じルール/Chrome内蔵AI/設定済みサーバーAI/テストモックを実行。 | 既存ルール抽出、AI根拠抽出、原文引用照合を利用。AI生成要点は引用文と区別。 | AI不使用の経路を残す。処理中はキャンセル可能。記事/段落が切り替わった古い応答は破棄。外部AIは既存設定で選び、状況検知だけでは送信しない。 | 実装・明示的モックAI操作と引用移動をE2E検証済み。実AI品質は未検証 |

### 状況別研究記録

設定画面の研究記録は初期OFFです。同意後だけ、最大5,000件のイベントをブラウザー内localStorageへ保存します。feature/version、許可リスト化したトリガー、各機能ON/OFF状態、手動/文脈提示/安全な自動復元の区別、AI処理方式、表示/開始/完了/無視/取消/失敗、許可リスト化した結果、待ち時間を記録します。本文、検索語、URL、メモ、記事ID、記事タイトル、モデル入力/出力はイベントに含めません。利用者がJSONを明示エクスポートでき、削除または同意撤回もできます。外部送信はありません。

記録は比較実験のためのローカル観察ログであり、ランダム割付、参加者ID、サーバー集計、実験条件の自動割付はありません。無視イベントは明示的に案内を閉じたケースでのみ記録し、表示後に何も押さなかったケースの無視は推定しません。F4の安全な自動復元は事実上の既存挙動を記録するもので、新たな自動書換えではありません。将来の比較でこれらを明示的に条件化する必要があります。

## D. AIアーキテクチャ・データ境界

- 能力契約は `services/contextual_ai_provider.ts` にあり、検索語候補、関連箇所、記事要約、型付き道具候補を扱います。結果はstatus、processor、model version、source ID/version、検証状態、失敗理由を保持します。キャンセル時は`AbortSignal`を扱います。
- classic-script UIが使う `public/js/contextual_ai_provider.js` は、`public/app.js`が公開するAPIクライアントと、`features_ui.js`の機能状態getterを使います。アダプターは `ContextualAiClient` をJSDoc型importし、`check:frontend`の型検査対象です。`tests/contextual_browser_adapter.test.ts`で実ブラウザーadapterの能力名、processor、出典版、原文照合状態、キャンセルsignal、AI利用不可を検査します。
- 検索語展開も `AbortSignal` をlocal Prompt API / 設定済みAPIへ渡します。検索語・キーワードを編集した時や検索を開始した時は保留中の生成を中断し、signal対応外のproviderから遅れて返った場合も、開始時と現在の語が異なれば結果を追加しません。
- `ContextualAiProvider`の低レベルfactoryは共通の利用可能性・失敗・キャンセル境界を提供しますが、現行Chrome/サーバーadapterはまだこのfactoryの実体として登録されず、`ContextualAiClient`の各能力メソッド内でengineを選択します。新しいproviderはUIを変えずに差し替えられますが、engine選択と結果変換のadapter更新は必要です。
- ルール処理とAI処理を分離します。F5は端末内Chrome Prompt APIのみ。F6は利用者が画面上で選択する既存engineを使い、設定済み外部AIを選んだ場合は既存サーバー経由で記事内容を送信します。文脈検出、表示、F2の失敗案内ではAIを呼びません。
- F5のAI出力は命令として実行しません。既存の算術専用validatorが本文根拠・式・変数・範囲を確認し、コード実行・DB永続化を禁止します。F6はAIの引用候補を原文照合し、記事本文の命令は信頼しません。
- Chrome Prompt APIの現行仕様は `AbortSignal`によるpromptキャンセルとsession管理を公開しています。非対応環境では機能を利用不可として通常のReaderへ戻ります。実ブラウザーで使えるかは環境依存です。

## E. テスト・性能

### 最終検証

- `npm.cmd run typecheck` — 合格。
- `npm.cmd run build:frontend` — 合格。
- `npm.cmd run check:frontend` — 合格。classic-scriptのAI adapterと共有TS型の整合もここで検査。
- `git diff --check` — 合格。既存の `public/app.js` CRLF/LF注意のみ。
- Vitest全体（`npm.cmd exec -- vitest run tests --exclude '**/*.test.mjs' --fileParallelism=false --reporter=default`）— **61ファイル、470合格 / 2 skip / 0失敗**。JSON reporterを使わず、新規専用TEMP内のSQLiteを使用。`tests/first-search-ui.test.ts`を含む。
- `tests/contextual_browser_adapter.test.ts`とprovider契約テスト — 初回7/7合格。今回の差分後に関連する8ファイルを再実行し **92成功 / 1 skip / 0失敗**。ブラウザーadapterの入出力・出典・AI利用不可・ローカル/設定済みserver providerへのAbortSignal引渡し、Prompt APIへの検索語展開signal引渡しを確認。
- `e2e/contextual-automation.spec.ts`と`e2e/reader-tools.spec.ts` — **29合格 / 2 skip / 0失敗**、Chromium・隔離SQLite、全31件・約1.3分。F1一意/複数/不一致、F2保存カード・収集検索エラーと再試行・案内表示ログ重複なし、検索語変更時のAI中断と古い候補の不適用、同意がある場合だけのAI語句生成イベント記録（本文・検索語なし）、F3引用/出典/export、F4下書き復元/破棄とReader再開、F5 OFF→ON→OFF・モックPrompt・非永続プレビュー、F6ルール→明示モックAI・出典ジャンプ、同意ゲート付き計測、OFF時の通常操作とReader Tools互換性を確認。イベント永続化は遅延flushのため、E2Eは保存完了をpollしてから件数を判定。
- 通常サンドボックスの初回Vitest実行では一時領域renameの`EPERM`、APIテストではloopback接続の`EACCES`が発生し、テスト本文まで進みませんでした。新規のリポジトリ内TEMPへ切り替えて隔離実行し、全体・E2Eを通過。今回のTEMPとE2E DBは終了後に削除しました。
- 全体Vitestのsite integration回帰テストは、11件診断のJSONを一時生成しますが、テストの`finally`で実行前のファイル内容を復元します。`npm test` / `npm run acceptance:test`のJSON reporter付きコマンド自体は、既存の追跡アーティファクトを上書きするため実行していません。

### 性能・未実施

HTTP APIの現行値を把握するため、既存 `benchmark_http.ts` の一時コピーを使い、結果JSONとSQLiteを追跡外の隔離TEMPへ出して100件の合成カードで1回測りました。初回GET 90.005ms、ウォームGETは10回平均10.042ms、候補API 698.688ms、保存カード検索10.158msで、スクリプト内の緩いしきい値を超えませんでした。これは現行状態の小規模ベンチで、変更前との比較ではありません。

Reader起動時間、AI待ち、状況判定の実ユーザー環境p50/p95、10k/30k記事での比較は未測定です。ベンチの100件値は規模拡張の性能目標を満たす証拠ではなく、E2E全体時間約1.2分もAPI応答性能の値ではありません。状況判定は同期的なlocalStorage設定読取と短い条件判定ですが、利用者環境での差分負荷は未測定です。同意ログはキャッシュを使い、UI一覧描画ごとの全件再解析を避け、最大5,000イベントに制限します。性能目標への合格とは扱いません。

未実行の全体検証：`npm test`と`npm run acceptance:test`の定義コマンド、E0/E6研究ラボ全検証、10k/30k HTTP/検索ベンチマーク、実Chrome内蔵モデル推論、実外部AI呼出し。HTTPの100件ベンチは、追跡済み結果ファイルを上書きしない一時コピーで実行済みです。全Vitest本体は別コマンドで実行済みです。外部AIを自動試験で呼んでいません。

## F. データ保全・互換性・残存リスク

- テストとE2Eは一時SQLiteを使用。`data/cards.db`や本番DBを操作するコマンドは実行していません。
- スキーマ変更なし。検索ランキング、既定の検索方式/重みは変更なし。
- Reader本文・既存カード本文をF1/F3/F5/F6が変更しません。F3は明示ボタン後に保存先メモへ追記し、source/target変更時はtransaction内比較で競合を拒否します。
- 引用位置は保存本文配列のSHA-256と段落番号を保持します。本文変更・削除後も引用文字列とメモを消さず、位置ジャンプは停止します。
- 設定と同意ログはアプリのlocalStorageです。研究記録は初期OFF、明示同意前に記録せず、ユーザー操作によるエクスポート/削除を提供します。ブラウザーのサイトデータ消去後は記録も失われます。
- 作業ツリーには今回より前からの未コミット変更・生成物が多く存在します。それらをreset、stash、commit、pushしていません。既存 `.tmp-vitest/` も保持し、今回の一時DBは専用TEMP内で作成後に削除しました。
- 残存リスク：低レベルprovider factoryを現行engine実装へ直接適用する共通routerは未実装で、追加providerごとにconsumer-facing adapterの分岐と結果変換が必要。各操作の無視イベントは明示的dismiss以外を推定できない。Chrome Prompt APIの実推論品質・環境互換、検索/Readerの性能比較、実利用者への利益は未検証。

## G. 今後の比較研究

既存の [E0–E9実験計画](my-search-codex-implementation-2026-11-05/decision_context/06_EXPERIMENTS_E0_E9.md) に従い、作業負担の観察と統合自体の効果を先に区別します。

1. E0で探す/読む/引用/比較/保存/再開の実負担と成果を観察。本文・発話の保存は既定OFF。ログ完全性と同意を予備試験で確認。
2. E6の統合効果は、機能・記事コーパス・提案品質・権限を揃えた分離型と統合型を直接比較。旧MVP比較とは別に集計。
3. 人間+AIの協働効果は、AI単独・人間単独・協働の別比較にする。統合UIの効果と混ぜない。
4. E1表示方式、E2タイミング、E4生成/実行権限は一度に複数軸を変えない。OFF対提示の差と、同じ提案を出すタイミング差を分ける。
5. 主指標は正確な成果への到達と総経過時間。管理、待ち、誤り確認・修正、見逃し、無視、取消、初回/継続利用を併記。本文・検索語を含む詳細ログは別同意を要求。
6. 事前に対象タスク、最小重要差、品質非劣性幅、除外・停止基準、解析方法を固定。設定・閾値は評価後に同じホールドアウトで調整しない。

現状の機能・記録は研究の準備を助けますが、研究割付と参加者運用は未実装です。自動化の既定化や利用者利益の主張には、別途人を対象にした比較結果が必要です。
