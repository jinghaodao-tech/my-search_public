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
| 情報源管理 `#source-modal` | Webサイト・RSS・arXiv・GitHub設定、既存サイト同期 | `openSourceModal`、`switchSourceTab`、`saveSourceConfig`、サイト一覧の同期処理 | 上部管理と検索画面の「情報源を追加」は同じ管理画面へのショートカットとして維持。 |
| BM25モード管理 `#mode-manager-modal` | モード追加・選択・状態／説明管理 | 「＋」は `addBM25Mode` → `openModeManagerModal`、作成は `confirmAddMode`、モード実行条件は `selectBM25Mode` | 旧「＋」のprompt作成と管理画面フォームは別処理だった。現在は同じ管理フォームを使う。 |
| CSV／JSON取込 `#modal-csv` | ファイルまたは貼付文字列をプレビューし、カードとして取り込む | `openCSVModal`、`switchImportTab`、`submitImport` → `/api/cards/import-csv` または `/api/cards/import-json` | 形式は異なるが1つの取込モーダルにまとめる。 |
| 状況別の補助機能 `#modal-contextual-settings` | 機能状態・ローカル記録の確認・出力・削除 | `openContextualSettings`、`exportContextualStudyEvents`、`clearContextualStudyEvents` | 機能設定と個別利用操作は責務が異なるため「管理」内に維持。 |

## 再監査で見つけた名称・導線の修正

- カード一覧の鉛筆を共有Editorへの直接入口として復元し、詳細画面へ移動するショートカットを維持した。
- BM25モードの「＋」は以前promptを開き、管理画面の「追加」は別フォームを使っていた。両方を同じ管理モーダルと作成関数へ接続した。
