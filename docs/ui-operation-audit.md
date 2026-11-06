# UI操作監査：編集経路の統合

## 編集操作の変更前

| 利用者の目的 | 入口・画面 | 保存処理 | 重複・問題 |
|---|---|---|---|
| 通常カードを編集 | カード上の鉛筆 → `modal-edit` | `submitEdit` → `PUT /api/cards/:id` | 記事カードも同じ本文欄へ送れるため、Reader形式の本文・出典構造を壊し得る。 |
| 記事・PDFを読みながら編集 | 詳細の「読んで編集」またはReader経由 → `modal-reader` | `saveReaderCard` → `PUT /api/reader/cards/:id` | Reader本文・引用を保持するが、通常メモを編集する共通入口ではなかった。 |
| 通常カードをスマホ編集 | モバイル専用パネル | `mepSave` → `PUT /api/cards/:id` とリンク全解除・再作成 | PCと入力項目・タグ区切り・リンク処理・保存実装が別。 |
| タグを編集 | 詳細画面の追加・削除操作 | 個別 `PUT /api/cards/:id` | 編集全体とは別の部分更新経路。 |
| 新規メモ作成 | `modal-new` またはモバイル専用パネル | `submitNewCard` または `mepSave` | 作成時にもPCとスマホで別フォーム・保存処理。 |

変更前には、少なくとも3種類のカード編集画面と4種類のクライアント保存関数があり、作成にも2種類の入力経路があった。編集を直接開く入口はカード上の鉛筆、詳細の編集、詳細のReader、詳細本文の「本文と一緒に開く」に分かれていた。

## 変更後

- 新規メモ、通常カード、Reader形式の記事、PDFは同じReader Editorの画面と `saveReaderCard` から操作する。
- 通常カードはタイトル・URL・タグ・メモを表示し、既存のカード本文形式のまま `/api/cards` に保存する。
- タグと色の変更も同じ画面・保存処理で行う。タグ個別更新は削除し、カード色を「色なし」に戻す更新をAPIで扱えるようにする。
- Reader形式の記事・PDFは保存済み段落を閲覧専用で表示し、メモ・タイトル・URL・出典項目・タグを `/api/reader` に保存する。引用本文と段落標識は保存ペイロードで変更しない。
- グリッドの鉛筆は便利なショートカットとして残し、詳細画面の「編集」と同じEditorへ接続した。詳細画面の「読んで編集」と本文欄の「本文と一緒に開く」は、詳細画面内で同じReader Editorを開く重複ボタンなので一本化した。
- 旧編集モーダル、スマホ専用編集パネル、詳細タグの即時編集を取り除いた。タグと色は共有Editorで編集する。
- 画面幅によって分岐するフォームや保存関数をなくし、Reader Editorのレイアウトだけをレスポンシブにする。

| 観点 | 変更前 | 変更後 |
|---|---:|---:|
| 保存カードの編集画面 | 汎用モーダル・Reader・スマホパネルの3 | 1 |
| 通常カードの作成フォーム | PCモーダル・スマホパネルの2 | 1 |
| 主な保存関数 | `submitEdit`・Reader更新・`mepSave`・タグ個別更新に分散 | `saveReaderCard` 1つ（内部でデータ形式別にAPIを選択） |
| 編集の主要画面 | 汎用モーダル・Reader・スマホパネルの3 | 1 |
| 詳細画面の編集入口 | 「編集」「読んで編集」「本文と一緒に開く」の3 | 「編集」の1 |
| 一覧を含む編集入口 | 詳細の3入口＋一覧の鉛筆の計4 | 詳細の「編集」＋一覧の鉛筆ショートカットの計2 |

## 主要シナリオの操作数

操作数は画面上の明示的なクリック数で数え、画面遷移数は編集UIを開くまでの表示面切替として数える。これはコードとPlaywrightの操作経路から数えたもので、利用者の迷い・所要時間の実測値ではない。

| シナリオ | 変更前 | 変更後 | 一貫性・判断 |
|---|---:|---:|---|
| 一覧から編集 | 鉛筆1クリック、編集モーダル1画面 | 鉛筆1クリック、共有Editor1画面 | クリック数・画面数を増やさず、詳細編集と同じ保存処理へ統合。 |
| 詳細から編集 | カード選択＋「編集」2クリック、汎用編集画面 | カード選択＋「編集」2クリック、共有Editor | 操作数は同じ。タイトル・タグ・メモ・出典が一つの編集画面に集約。 |
| 詳細から原文を見ながら編集 | カード選択＋「読んで編集」または「本文と一緒に開く」2クリック、Reader | カード選択＋「編集」2クリック、原文を表示する共有Editor | 詳細内の同目的ボタン3つを1つに整理。記事・PDFの原文は閲覧専用。 |

いずれもクリック数の短縮は主張しない。改善点は編集画面と保存処理の分裂、詳細画面の選択肢の重複を解消したこと。利用者が実際に迷わなくなったかは未測定。

カード検索、Readerを開く、検索候補の確認、引用をコピー・メモへ挿入・別メモへ移す、保存検索の作成・復元・削除、CSV/JSON取込、情報源種別ごとの登録、要約、アーカイブ、削除、Markdown出力、カード間リンクは、目的や対象・副作用が異なるため一括統合の対象にしない。本文とメモのテキスト／表表示は同じメモを編集する同一画面内の表現選択であり、別の保存経路ではない。

## 画面横断の操作確認

| 画面・機能群 | 利用者の目的 | 似て見える操作 | 統合判断 |
|---|---|---|---|
| 検索・新着発見 | 検索条件を指定し、新着候補を比較・保存する | 保存済みカード検索、記事候補検索、保存検索の保存 | 対象コーパスと結果状態が異なる。保存検索は検索条件を再利用する機能として維持し、カード編集とは分離。 |
| 候補レビュー | 見つかった候補を確認、保留、見送り、保存する | 候補からカードを読む・保存する | 状態遷移とカード編集は異なる操作。Readerで読む経路は共有Editorを開き、候補状態ボタンは維持。 |
| Reader・PDF | Web記事/PDFを開き、原文を照合する | URL取得、PDF選択、手動本文貼付 | 入力元・抽出方法が異なるため同じReader上の選択肢として維持。編集後の原文・引用位置は保護。 |
| 引用 | 本文の引用をコピー、現在のメモへ追加、別メモへ移す | 引用関連の複数ボタン | クリップボード、同一カードメモ、別カードへの書込みで対象と副作用が異なる。原文照合・位置移動も別目的。 |
| 保存カード | 記事・PDF・メモを編集、リンク、分類する | 色・タグ・リンク・アーカイブ・削除 | 内容編集は共有Editorへ統合。リンク変更、分類、アーカイブ、削除は関係や状態が変わる別操作として維持。 |
| 情報源・データ取込 | RSS、Web、arXiv、GitHub、CSV、JSONを登録する | 追加・取込の複数経路 | 形式と登録されるデータ構造が異なる。タブや取込形式は一つの管理モーダル内に維持。 |
| 要約・AI支援 | 保存記事の要約、Readerの根拠候補、検索補助を得る | AI関連ボタン | 入力、出力、外部送信条件が異なる。通常の保存や明示的引用と統合しない。 |
| KJ法・カードリンク | グループ配置や知識間リンクを編集する | カード編集に見える関係編集 | カード内容でなく関係・配置を変更するため分離。スマホでも詳細パネルのリンク操作を使う。 |

この表はコード上の主要画面と操作を目的別に監査した記録であり、実利用者観察や全てのブラウザー幅の操作保証を意味しない。

## 変更範囲と未確認事項

- UIコードの確認対象：`public/index.html`、`public/js/cards_ui.js`、`public/js/reader_ui.js`、`public/js/mobile_edit.js`、`public/styles.css`。
- 既存SQLiteスキーマの変更は行わない。
- 本番DBやユーザーカードはこの検証で使用しない。
- Playwrightによる通常メモ・記事・PDFの作成／編集／再表示と、Reader原文・ページ標識・出典メタデータの維持を確認する。
- 実端末のVoiceOver/TalkBack、長文・大容量PDFの画面操作、キーボードのみの全画面操作は別途確認が必要。
- Reader形式ではない旧形式の記事カードは通常カード形式を保持して編集する。Readerの原文・引用分離が保証されるのは、保存時点からReader形式として保存されているカードである。

## 画面・操作・処理の対応

| 画面・コントロール | 表示名／目的 | 呼び出し先・保存先 | 重複／判断 |
|---|---|---|---|
| 上部タブ | カード一覧 `#card-grid`・候補レビュー `#candidate-view`・グルーピングボード `#kj-board`・Zettelkasten `#zettel-view`・探す `#bm25-view` | `switchView` (`public/js/views.js`)、候補は `/api/candidates`、KJは `/api/kj/groups`、Zettelkastenは `/api/zettelkasten/graph`、検索は `/api/search/targets` | 画面対象が異なるので分離。グルーピングとZettelkastenは「整理」へまとめる。 |
| カード一覧検索・表示 | 保存済みカードを検索、カード／表表示、通常／アーカイブ、種類・タグで絞る | `onSearch`、`setCardLayout`、`filterArchived`、`filterType`、`filterTag` | 同じ一覧内の表示・絞り込み状態。検索画面の検索先選択とは分離。 |
| カード一覧の鉛筆 | 選択カードを編集するショートカット | `openEditModal` → `openReaderForCard` → `saveReaderCard` | 詳細を先に開く手間を省くため残し、詳細の「編集」と同じEditorを使用。 |
| 詳細の編集 | タイトル・本文・メモ・出典を編集 | `openEditModal` → `openReaderForCard` → `saveReaderCard` | 詳細画面内の主要入口。旧「読んで編集」「本文と一緒に開く」は同一Editorを開くため統合。 |
| メモ作成・FABのメモ | 通常メモを新規作成 | `openNewCardModal` → `openPlainCardEditor` → `saveReaderCard` → `/api/cards` | 上部とFABは同じ作成画面への便利な入口。ショートカットとして両方残す。 |
| 一括操作 | 選択カードのアーカイブ・復元・Markdown出力・削除・要約 | `toggleMultiSelect`、`archiveSelected`、`restoreSelected`、`exportSelectedMarkdown`、`deleteSelected`、`summarizeBulk` | 対象件数・副作用が異なる。単カード編集へ統合しない。 |
| タグ整理 | 表記揺れを確認し、選択後に統合 | `toggleTagTidy`、`POST /api/tags/merge` dry-run後に確定 | Editorでタグを個別編集する操作とは対象が異なるため維持。 |
| 候補レビュー | 状態を絞る、レビュー済み、読んでメモ、カードに保存、見送る | `loadCandidates`、`reviewCandidate`、`openReader`、`saveCandidateAsCard`、`expireOneCandidate` | 候補の状態更新とカード編集は異なる。Readerは候補URL・IDを引き継ぐ。 |
| グルーピングボード・グループ作成 `#modal-group` | グループ作成・名前変更・削除、カードのグループ移動 | `openNewGroupModal`、`submitGroup`、`editGroup`、`deleteGroup`、`kjDrop` | グループ・所属関係の編集。カード本文のEditorとは別責務。 |
| Zettelkasten | 関連カードのネットワーク表示、カード詳細へ移動 | `loadZettelkasten`、ノード選択時 `selectCard` → `switchView('cards')` | 関係の閲覧・移動であり、カード本文編集とは別操作。 |
| 記事検索 | 検索先選択・セット、条件保存／復元／削除、検索実行、候補の閲覧・保存 | `loadSearchTargets`、`runSearchScreen` (`POST /api/run` またはカード検索API)、`saveCurrentSearch`、`restoreSavedSearch`、`deleteSavedSearch` | 保存済みカード検索・新着記事検索・検索条件保存は対象が異なる。 |
| Reader `#modal-reader` | Web URL読込、PDF選択、手動本文、ソース登録 | `loadReaderArticle`、`chooseReaderPdf`、`applyManualReaderText`、`registerReaderSite` | 入力元ごとの選択肢だが、読取・メモは同じReader画面を使う。 |
| Readerメモ・引用 | テキスト／表表示、要点と根拠、引用・元へ移動・別メモへ転送、保存 | `setMemoMode`、`runEvidence`、`quoteReaderSelection`、`jumpToQuoteSource`、`prepareQuoteTransfer`、`saveReaderCard` | 表／テキストは同じメモの表示形式。コピー、同一カードへの挿入、別カードへの書込みは副作用が違うため分ける。 |
| 情報源管理 `#source-modal` | Webサイト・RSS・arXiv・GitHub設定、既存サイト同期 | `openSourceModal`、`switchSourceTab`、`saveSourceConfig`、サイト一覧の同期処理 | 上部管理と検索画面の「情報源を管理」は同じ管理画面へのショートカットとして維持。 |
| BM25モード管理 `#mode-manager-modal` | モード追加・選択・状態／説明管理 | 「＋」は `addBM25Mode` → `openModeManagerModal`、作成は `confirmAddMode`、モード実行条件は `selectBM25Mode` | 旧「＋」のprompt作成と管理画面フォームは別処理だった。現在は同じ管理フォームを使う。 |
| CSV／JSON取込 `#modal-csv` | ファイルまたは貼付文字列をプレビューし、カードとして取り込む | `openCSVModal`、`switchImportTab`、`submitImport` → `/api/cards/import-csv` または `/api/cards/import-json` | 形式は異なるが1つの取込モーダルにまとめる。 |
| 状況別の補助機能 `#modal-contextual-settings` | 機能状態・ローカル記録の確認・出力・削除 | `openContextualSettings`、`exportContextualStudyEvents`、`clearContextualStudyEvents` | 機能設定と個別利用操作は責務が異なるため「管理」内に維持。 |

## 再監査で見つけた名称・導線の修正

- カード一覧の鉛筆を共有Editorへの直接入口として復元し、詳細画面へ移動するショートカットを維持した。
- BM25モードの「＋」は以前promptを開き、管理画面の「追加」は別フォームを使っていた。両方を同じ管理モーダルと作成関数へ接続した。
- 「ソース管理」「＋ サイトを追加」「情報源を追加」は同じ `#source-modal` を開いていたため、「情報源を管理」に統一した。検索画面・管理メニューいずれの入口も同じ画面を開くことをPlaywrightで確認する。
- 上部と空状態のメモ作成表記を「メモを作成」にそろえ、FABの短い表示「メモ」には同じアクセシブル名を付けた。上部とFABは同じReader Editorを開くショートカットとして残す。
- データ取込のFABは短い表示「CSV」を保ち、表示ラベルとアクセシブル名を「データ取り込み」にそろえた。CSV/JSONの選択は同一モーダル内で行う。
- `MD Export`、詳細の `MD`、要約の `Delete`、検索キーワード行の `Remove`、サイドバーの `Toggle sidebar` という英語表記を、画面全体で使う日本語の操作名に合わせた。内部関数・API・保存形式は変更しない。

## 操作一覧の追加確認

同じ目的の複数入口は、名称と着地先を合わせた便利なショートカットとして残す。独立した保存処理が増えないことを確認するため、Playwrightでは入口ごとに開いたモーダルのIDも確認する。

| 目的 | 入口 | 共通の着地先 | 統合の扱い |
|---|---|---|---|
| 情報源を管理する | 上部「管理」／検索条件の検索先／検索結果の案内 | `openSourceModal()` → `#source-modal` | 同じ管理画面を開く3入口。追加と管理を別画面に分けず、入口名も「情報源を管理」に統一。 |
| 通常メモを作る | カード一覧上部／FAB | `openNewCardModal()` → `#modal-reader` の通常メモEditor | 表示寸法だけ異なる同じ操作。保存は共有Editorの形式別アダプターへ集約。 |
| 保存データを取り込む | 上部「管理」／FAB | `openCSVModal()` → `#modal-csv` | 同一モーダル内でCSV/JSONを選ぶ。FABはアイコン幅に合わせた短い表示を維持し、アクセシブル名を統一。 |
| Markdownを書き出す | 選択カードの一括操作／詳細画面 | `exportSelectedMarkdown()`／`exportMarkdown(id)` | 対象件数が異なるため実行処理は別だが、利用者向けの操作名を「Markdown出力」に統一。 |
| AI要約を扱う | 詳細の要約生成／既存要約の削除／複数カードの一括要約 | `summarizeOne()`／`deleteSummary()`／`summarizeBulk()` | 生成と削除は副作用が逆で、一括生成は対象数が異なる。ボタンを一つにまとめず、日本語ラベルで目的を明示。 |

### 今回増やした画面検証

- 情報源管理は、検索画面内と上部「管理」の両方から同じ `#source-modal` に遷移する。
- メモ作成は、カード一覧上部とFABの両方から同じ `#modal-reader` を開く。
- データ取込は、上部「管理」とFABの両方から同じ `#modal-csv` を開く。
- これらの確認はモーダルを開閉する操作で、カード・情報源・取込データを作成・変更しない。
- 表示名の整合はコード上の文字列とPlaywrightのロール名で確認する。利用者の迷いが減ったか、操作時間が短縮したかは未測定。

## 画面別の操作一覧（全画面）

下表は `public/index.html` の主要画面・ダイアログと、カード・候補・Readerが `public/js/` から動的に描画する主要アクションを呼び出し先まで追跡したもの。アイコンだけの短縮表示はアクセシブル名を記録した。Playwrightの画面到達チェックは `e2e/ui-surface-audit.spec.ts`、作成・編集・保存の実操作は `e2e/card-editor-consolidation.spec.ts`、Readerの引用・出典照合は `e2e/reader-tools.spec.ts` に分けている。

| 面／要素 | 利用者の目的・主要操作 | 呼び出し先・結果 | 監査上の判断 |
|---|---|---|---|
| 共通ナビゲーション | カード一覧、候補レビュー、グルーピングボード、Zettelkasten、探すへ移動 | `switchView()` → `#card-grid` / `#candidate-view` / `#kj-board` / `#zettel-view` / `#bm25-view` | 対象と作業状態が異なるため分離。小さい画面では一部を「その他」に収め、同じ画面を開く。 |
| カード一覧 `#card-grid` | カード検索、通常／アーカイブ切替、種類・タグ絞り込み、カード／表表示、タグ整理、新規メモ、複数選択 | `onSearch()`、`filterArchived()`、`filterType()`、`filterTag()`、`setCardLayout()`、`toggleTagTidy()`、`openNewCardModal()`、`toggleMultiSelect()` | 表示・絞込みは同じ一覧状態。選択後の一括操作は複数件へ作用するため単カード編集と分離。鉛筆は共有Editorへのショートカット。 |
| カード詳細 `#detail-panel` | 編集、アーカイブ、Markdown出力、削除、要約、リンク、Reader表示 | `openEditModal()`、`toggleArchived()`、`exportMarkdown()`、`deleteCurrentReaderCard()`、`summarizeOne()` / `deleteSummary()`、リンク操作、`openReaderForCard()` | タイトル等の編集は共有Editor。アーカイブ・出力・削除・要約・関係編集は副作用が異なるため個別操作を維持。 |
| 候補レビュー `#candidate-view` | 候補更新、状態絞り込み、確認済みにする、Readerで読む、メモとして保存、見送り | `loadCandidates()`、候補状態フィルター、`reviewCandidate()`、`openReader()`、`saveCandidateAsCard()`、`expireOneCandidate()` | 候補の状態変更と保存カード編集を分離。保存後のカード編集は一覧・詳細の共通Editorへつなぐ。 |
| グルーピングボード `#kj-board` / `#modal-group` | グループ追加・名前変更・削除、カードの移動 | `openNewGroupModal()`、`submitGroup()`、`editGroup()`、`deleteGroup()`、ドラッグ移動 | グループと所属関係の操作。カード本文Editorへ混ぜない。 |
| Zettelkasten `#zettel-view` | 関連カードを探索して詳細へ移動 | `loadZettelkasten()`、ノード選択 → `selectCard()` → `switchView('cards')` | 関係の閲覧と移動が目的。本文編集入口は追加せず、詳細画面へ集約。 |
| 検索 `#bm25-view` | 条件入力、実行、検索先管理、条件の保存・別名保存・復元・削除、キーワード追加・削除、AI類義語追加、同じ語でWeb検索 | `runSearchScreen()`、`openSourceModal()`、`saveCurrentSearch()`、`restoreSavedSearch()`、`deleteSavedSearch()`、`addKeyword()`、`expandKeywordsWithAI()`、`openExternalSearch()` | 保存カード検索と新着候補検索を結果ラベルで区別。AI拡張は明示操作のまま。条件保存は検索結果の保存と誤認しない名称・位置を維持。 |
| 検索結果・候補の一括操作 | 結果記事を読む、カードに保存、フィード収集、アーカイブ表示 | `openReader()`、`saveTopAsCards()`、`refreshInputArticlesNow()`、`toggleArchived()` | 取得・保存・状態変更で副作用が異なる。検索条件管理と同一ボタンへ統合しない。 |
| Reader / 共通Editor `#modal-reader` | URL取得、PDFを開く、サイト登録、手動本文反映、候補の保留・見送り・次へ、要点と根拠、保存・削除 | `loadReaderArticle()`、`chooseReaderPdf()`、`registerReaderSite()`、`applyManualReaderText()`、`decideReaderSearch()` / `nextSearchArticle()`、`runEvidence()` / `cancelEvidenceRequest()`、`saveReaderCard()` / `deleteCurrentReaderCard()` | 入力元別の読込は同じReaderへ統合。保存済み原文・PDFページ標識は閲覧専用。メモ・引用等の編集は共有保存経路を使う。 |
| Readerメモ・引用 | テキスト／表表示、選択を引用、出典付きコピー、引用元へ移動、同じメモへ挿入、別メモへ転送、AI道具案 | `setMemoMode()`、`quoteReaderSelection()`、`copyCitedSelection()`、`jumpToQuoteSource()`、`transferReaderQuote()`、`prepareQuoteTransfer()`、`proposeReaderToolForSelection()` | コピー、現在メモへの追記、別カードへの保存、位置照合は対象・副作用が異なるため別操作を維持。曖昧な引用位置は自動で推測しない。 |
| 情報源管理 `#source-modal` | Web/RSS/arXiv/GitHubの設定、サイト調査、設定保存 | `openSourceModal()`、`switchSourceTab()`、`previewSite()`、`addSrcRow()`、`saveSourceConfig()` | 管理上部、検索条件、検索結果からの入口は同じモーダルへ統一。設定内の情報源種別は別接続先を表すためタブを維持。 |
| データ取り込み `#modal-csv` | CSV／JSON選択、ファイル／テキスト取込、取込確定 | `openCSVModal()`、`switchImportTab()`、`submitImport()` → CSV/JSON API | 入口は管理メニューとモバイルFABに統一。形式の選択は同一モーダル内。 |
| モード管理 `#mode-manager-modal` | 検索モード追加・編集・選択 | `openModeManagerModal()`、`confirmAddMode()`、`selectBM25Mode()` | 「＋」と「管理」の追加フォームを統一済み。別prompt経路は置かない。 |
| 状況別補助管理 `#modal-contextual-settings` | ローカル記録のエクスポート・削除、参加撤回 | `openContextualSettings()`、`exportContextualStudyEvents()`、`clearContextualStudyEvents()`、`withdrawRefindStudy()` | 設定・記録管理は記事の検索／編集操作と別の責務。破壊操作は確認を伴う。 |
| モバイルFAB | メモ作成、データ取り込み | `openNewCardModal()` → `#modal-reader`、`openCSVModal()` → `#modal-csv` | 狭い表示ラベルでもアクセシブル名はデスクトップと共通。両入口は便利なショートカットとして維持。 |

## 問題・根拠・影響・リスク

| 検出した問題と根拠 | 利用者への影響 | 対応 | 変更リスク／残る確認 |
|---|---|---|---|
| 保存カード編集が `modal-edit`、Reader、スマホ専用パネルに分かれ、`submitEdit()`・Reader保存・`mepSave()`へ分岐していた（変更前コードと `public/js/mobile_edit.js` を確認）。 | カード種別・端末によって編集項目、タグ、リンク保存の挙動を使い分ける必要があり、記事原文を汎用本文で上書きする恐れがあった。 | 共通Editorと `saveReaderCard()` へ統合。カード一覧鉛筆は残し、詳細の同目的編集入口を整理。 | 保存形式を維持するために形式別APIアダプターは残る。PC/モバイル、メモ/記事/PDFのPlaywrightで保存後の値を確認。 |
| 詳細の「読んで編集」と「本文と一緒に開く」は同じReaderを開き、「編集」は別画面を開いていた。 | 似た目的の3候補から画面と機能差を推測する必要があった。 | 詳細からの編集は「編集」へ統合し、原文も同じEditorで表示。 | Readerへ入る独立した「読んでメモ」は新規読込という別目的なので残す。 |
| 情報源・メモ・取込に入口ごとの名称差があったが着地先は同じ。 | 同じ操作か判断しにくく、特にアイコン表示で支援技術向け名称が不十分だった。 | 表示名／アクセシブル名を共通化し、入口ごとに同じモーダルを開くE2Eを追加。 | 操作時間や利用者の迷いの減少は測定していない。 |
| Markdown出力、要約削除、検索キーワード削除などに英語の混在表記があった。 | 目的を画面ごとに読み替える必要がある。 | 同じ目的の日本語ラベルへ統一。 | 表示名のみの変更。ダウンロード形式や削除対象は変えていない。 |
| 収集、検索、候補状態、引用コピー／移動、アーカイブ、削除、一括操作は似た場所にあるが副作用が異なる。 | まとめ過ぎると実行対象や結果を誤認する可能性がある。 | 責務が異なる操作は別のままにし、一覧で呼び出し先と理由を明示。 | 文言が自然かは本人・第三者の試用で未確認。 |

## 主要シナリオの画面遷移数・操作数

クリック数はPlaywrightで通った経路の明示操作数。画面遷移は別の主要面（詳細／モーダル）へ移った数。入力・待ち時間・操作ミスは数えず、操作一貫性はコード経路の同一性で評価する。変更前は `origin/main` の実装、変更後はこのブランチを比較して数えた。利用者が感じる迷い・負荷の実測ではない。

| シナリオ | 変更前 | 変更後 | 実測・判断 |
|---|---|---|---|
| 一覧カードの鉛筆から編集 | PC: 鉛筆1回→汎用編集モーダル。モバイル: 専用編集パネル。 | PC/モバイル: 鉛筆1回→共有Editor。 | クリック1、画面1は同じ。編集画面・保存処理の分岐を1系統へ統合。 |
| 詳細画面から編集 | カード選択→「編集」で2クリック・汎用モーダル。記事原文を見る経路は別ボタン。 | カード選択→「編集」で2クリック・共有Editor。 | クリック2、画面2（一覧から詳細、詳細からEditor）。選択肢3種を1つにし、記事/PDFでは原文を同時表示。 |
| 新規メモ作成 | PCモーダル／モバイルパネルの異なるフォーム。 | PC/モバイルともメモ作成→共有Editor。 | 起動1クリック＋保存1クリック。表示面は一覧からEditorの1遷移。 |
| 情報源管理（検索画面／管理メニュー） | 同じ設定を別名称の入口から開く。 | 共通名称の入口→同じ `#source-modal`。 | 入口1クリック、画面1遷移。名称と着地先の一貫性をE2Eで確認。 |
| データ取込（管理メニュー／モバイルFAB） | 同じ取込目的の入口名称・表示方法が異なる。 | 管理メニュー／FAB→同じ `#modal-csv`。 | 入口1クリック、画面1遷移。CSV/JSONの選択はモーダル内で行う。 |

実際の所要時間・認知負荷・誤操作率は、本人または第三者の操作観察が必要であり、今回の自動操作数から改善したとは主張しない。
