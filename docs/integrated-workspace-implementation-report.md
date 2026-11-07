# 統合型 Research & Writing Workspace 実装・検証記録

更新日: 2026-11-06
対象: 現在のローカル `main` 作業ツリー（基準コミット `94fc15b` と、その時点ですでに存在した未コミット変更を含む）。公開版のコミットだけを動作根拠にはしていない。

## 既存実装の再利用・追加

| 領域 | 再利用・変更・追加 | 現在の状態 |
|---|---|---|
| 保存記事・Reader | 既存 `cards`、Reader本文、Readerのページマーカー、引用照合を再利用 | 既存カード・本文・メモの書換えはしない。原稿用テーブルを追加 |
| 原稿データ | `documents`、`document_sources`、`document_citations` をmigration 027で追加。migration 028で `document_clips` を追加 | MarkdownをschemaVersion付きJSONとして保存し、版番号で競合を検出 |
| 原稿API | CRUD、本文検索、出典関連付け、引用登録、外部クリップ登録、Markdown出力、記事から原稿への逆引き | SQLite transaction、入力検証、引用本文の一致・一意位置・本文hash確認を使用 |
| 編集UI | 新規作成、一覧、編集、保存、削除、Markdown出力、ローカル下書き復旧、安全なプレビュー | Markdown textareaに見出し・箇条書き・表・リンク・太字・斜体・引用の操作ボタンを追加。プレビューはDOM要素とテキストノードで描画し、HTMLを実行しない。Tiptap等の構造化リッチテキストUIと明示Undo/Redoボタンは未実装（textarea標準のCtrl+Z/Ctrl+Yは利用可） |
| 検索への受け渡し | 原稿の選択範囲を既存の保存カード検索へ渡し、Readerから元のカーソル位置へ戻す | E2Eで保存カード検索→Reader→引用→原稿復帰を確認。Web探索や収集候補の全検索先を含む復帰は未検証 |
| 複数資料 | 既存 `/api/reader/passages` のルール抽出を再利用。確認済み引用から端末内AI比較案を生成 | ルール抽出は意味上の比較ではない。AI比較は3資料以上の確認済み引用が必要で、解釈の正確性は保証しない |
| AI執筆補助 | `ContextualAiClient`に構成案、資料比較、主張と根拠の点検、選択文章改善を追加。Chrome Prompt APIを明示操作で呼ぶ | 生成文はプレビュー後に利用者が適用。処理中止・古い原稿結果の破棄・引用hash再確認を実装。実機モデルの出力は未確認 |
| 出典 | 引用文字列、出典タイトル/URL、保存本文hash、段落、可能ならPDFページラベルを保存 | 引用元本文の変更・欠落・重複一致を未検証状態として表示し、別位置へ自動再結合しない |
| 外部ページの引用候補 | 選択文・ページ名・HTTPS URLを未検証クリップとして原稿へ保存できる | 保存Reader本文との一致を示さない。実ページから選択文を受け取る正の動作は未実機確認 |
| PDF | PDF.jsの抽出本文と、利用者が選んだPDFファイルのページ表示を切替 | E2Eで2ページ目の描画を確認。原本はブラウザーのメモリ上のみで、再起動後は再選択。抽出用ファイルは現在のmy-searchサーバーへ送信 |
| デスクトップ | Electron `WebContentsView`で内蔵ブラウザーを追加。Node/IPCなしのリモートWebContents、URL制限、タブ/履歴操作、権限・ダウンロード・新窓拒否 | E2Eで起動、2タブ、HTTP URL拒否、remote rendererのNode/IPC非公開、sandbox等の設定を確認。実サイトのページ表示・許可要求・ダウンロード拒否・選択文の正の転送は未確認 |
| 試用データ | 既存の `npm run trial` の隔離一時DBと架空記事/PDFを利用 | 3枚の保存カード（Web記事2、PDF 1）を確認。既存の `data/trial.db` と通常DBは使わない。ローカル試用と共有デモをAPIの `demoDataScope` で区別し、データ共有/保持期間の注意書きを実際の起動範囲に合わせる |

## 操作

### Web版

1. `npm run trial` を実行し、表示された `http://localhost:<port>` を開く。
2. 「書く」→「新しい原稿」で原稿を作る。
3. 「保存資料を追加」から見本Web記事2件と見本PDF 1件を追加する。
4. 論点を入力し「3件以上の資料から根拠候補を抽出」。ルール抽出の引用候補はReaderで原文を確認してから挿入する。
5. 原稿中の一節を選び「選択文から検索」。保存カードをReaderで開き、本文を選んで「引用を原稿へ追加して戻る」。
6. 引用マーカーからReaderの該当段落へ戻る。「使用原稿」から原稿の使用位置へ逆引きする。
7. 保存、Markdown出力、再読込、下書き復旧を試す。

### Electron版

- 見本だけで試す: `npm run desktop:trial`（終了時に専用一時DBを削除）。
- 通常DBで起動: `npm run desktop`。`DB_PATH` があればそのパス、未設定ならWeb版と同じ `data/cards.db` を使用する。別々のサーバー/サイト同期が同じDBに同時接続しないよう、Web版とElectron版は切り替えて使う。
- 検索結果の「内蔵ブラウザーで開く」か上部の「内蔵ブラウザー」で別ウィンドウを開く。HTTPSページで文を選択し「選択文をmy-searchへ」を押す。原稿側で内容とURLを確認し、「未検証クリップとして原稿に追加」を明示的に押す。

## 検証結果

| コマンド/操作 | 結果 |
|---|---|
| `npm run typecheck` | 成功 |
| `npm run build:frontend` | 成功 |
| `npm run check:frontend` | 成功 |
| `npm run build` | 成功。105ファイルを `dist/` に生成 |
| `npm run check:third-party-notices` | 成功。kuromoji Apache-2.0とmecab-ipadic通知を確認、MIT宣言は変更していない |
| `npx vitest run tests --exclude '**/*.test.mjs' --fileParallelism=false --reporter=default` | 62ファイル、479 passed、2 skipped |
| Core Vitest (`server.test.ts`, `query_parser.test.ts`, `articles-first-seen.test.ts`) | 3ファイル、38 passed |
| `tests/new_discovery_metrics.test.mjs`等の5ファイル | 25 passed |
| Playwright Web回帰（通常Web、Reader、F1〜F6、refind、統合） | 49件中47 passed、2 skipped。`research-experiment-*` の4 specとElectron専用specは別条件で分離 |
| ElectronセキュリティE2E | 専用実行で1 passed（13.0秒）。不正HTTP拒否、2 HTTPSタブ、remote rendererのNode/IPC非公開、sandbox等を確認。Web回帰と同じ実行へ含めた際は、Electron初回起動が90秒で一度timeoutし、単独再実行は成功 |
| 統合ワークスペースE2E | 保存記事からの比較/引用、選択範囲の装飾と行引用、プレビュー、原稿再読込、下書き復旧、PDF原本2ページ目を個別テストで確認。再起動をまたぐ経路は専用E2Eに分離 |
| 統合ワークスペース再起動E2E | `e2e/integrated-restart.spec.ts` 1 passed。独立Temp DBでReader引用・メモを保存→メモ語から保存カード検索→出典を原稿に引用→サーバープロセス停止・同じDBで再起動→原稿/照合済み引用/ReaderメモをUI復旧→引用元Readerへ復帰→メモ語で再検索、Markdown出力と資料側逆引きを確認 |
| ElectronデスクトップE2E | 起動し、2タブ・HTTPS限定・HTTP拒否・remote rendererの権限境界を確認 |
| 文書API/ローカルAI focused tests | 25 passed。未検証クリップ、Origin拒否、確認済み引用だけを使うAIプロンプトを含む |
| `npm run trial` 実起動 | 専用一時DBで healthz healthy、カード3件、原稿0件、refind status 200、トップページ200。終了後の一時DB削除を確認 |
| 公開HEADの隔離クリーン起動 | GitHub `main` 94fc15bの隔離アーカイブで `npm ci` 成功。325 packages追加、moderate 4 / high 5 / critical 1 の監査警告。`npm run trial` でトップ200、healthz healthy、カード3件、UI表示を確認。非TTYコマンドセッションを終了するときに残った固有Temp DBは手動削除し、ポートも閉鎖 |
| Ctrl+C後の一時DB削除 | 作業ツリーでTTYを割り当てて `npm run trial` を起動し、healthz healthyを確認。端末上でCtrl+C後、ポートが閉じ、ログに出た固有Temp DBが自動削除されることを確認 |
| ローカル/共有デモのスコープ表示 | ローカル試用APIが `demoDataScope=local` を返し、画面に「通常利用DBと分離した専用DB」と表示。APIの共有スコープ切替テストを含むdemo.test.ts 8件成功。Render Blueprintは `shared` を設定 |
| `npm run desktop:trial` 実起動 | 専用一時DBでElectronとサーバー起動、healthz healthy、カード3件、原稿0件を確認。終了後の試用DBを確認し消去 |
| `npm audit --audit-level=high` | 作業ツリーのロックファイルでは互換範囲内の修正後、0 vulnerabilities。公開HEADの隔離 `npm ci` ではmoderate 4 / high 5 / critical 1 と報告され、公開HEADと作業ツリーで依存状態が異なる |
| `git diff --check` | 成功 |

初回の試用起動では、汚れた作業ツリーで `git ls-files` の出力が既定のchild-process bufferを超え、refind statusが500になった。指紋取得の上限を64MiBへ設定し、次の隔離試用でrefind status 200を確認した。初回Electron起動ではapp.ready前のsession参照エラーがあり、session作成をready後へ移動して再試験した。

Vitest実行時、Windows sandboxの既定Tempでは一時ファイルrenameが `EPERM`、APIテストのloopback bindが `EACCES` になった。Tempをリポジトリ内の既存一時テスト領域へ指定し、ローカルソケットだけ権限を得て再実行し、上記結果を得た。テスト結果JSONを上書きする既存npm scriptは避け、同等のCLI引数で実行した。

実際のPrompt APIモデルでAI提案を生成した記録はない。ブラウザーにAIがないときに生成物を捏造しないことはE2Eで確認した。AIの品質・作業時間短縮・利用者利益は評価していない。

## 未実装・未検証

- Markdown textareaのため、構造化リッチテキスト、表/見出しの堅牢な編集、明示的Undo/Redo UI、共同編集、変更履歴は未実装。
- Electronの内蔵ブラウザーは合成E2Eで分離設定を確認したが、実サイトの読み込み成功、実ページ選択文の正の転送、権限要求/ダウンロード/新窓の実動作拒否は未検証。試用ウィンドウでの人手UI操作も未実施。
- 引用本文の機械的一致は、その引用が周辺の主張を支えることや主張が真実であることを証明しない。AI案も同様に利用者確認が必要。
- 原稿データのページ再読込と、サーバープロセス再起動後に原稿・照合済み引用を画面で復旧し、Reader出典・Markdown出力・資料側逆引きを確認するPlaywright E2Eを実施した。長期保存・実利用環境での破損耐性は未評価。
- 未検証クリップの出典URLは保存されるが、取得不能な原文の検証状態を解消する再取得ワークフローは未実装。
- `npm run trial` では保存・Reader・引用に使用できるが、比較から原稿を再起動後に復元する実演手順は一人の試用者が別途確認できる。
- 統合ワークフローが分離ワークフローより有益であること、AI支援の改善効果、実利用者の操作負担は未実証。

本変更では検索ランキング既定値を変えていない。通常の本番DBに対してテスト・migration・削除を行っていない。`npm run trial` と `desktop:trial` は別々の一時DBを使用した。コミット・pushはしていない。
