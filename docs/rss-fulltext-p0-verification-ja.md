# RSS本文の保存と検索の修正

## 対象

`my-search-rss-p0-patch.zip` の内容を確認し、通常のRSS収集と登録サイトのRSS/Atom収集に適用する。既存の記事ID、カード、メモ、Reader保存本文、本文取得の許可設定は変更しない。

## 変更

- 本文選択を `services/rss_content.ts` に共通化し、空でない `content:encoded` を優先する。フォールバックは `content`、`summary`、`contentSnippet` の順。
- 旧来の1,200文字での打ち切りをやめ、検索対象本文を最大100,000文字、概要を最大1,000文字にする。
- HTMLは既存依存のjsdomでテキスト化する。スクリプト・スタイル等を除去し、文字参照を復号し、段落間を空白で区切る。スクリプトの実行や外部リソースの取得は行わない。
- `content:encoded` の本文を切り詰めず保持できた場合のみ、フィード由来の `fulltext` とする。概要へのフォールバックや上限超過は `excerpt` とする。
- サイト登録経由では `bodyPolicy: body` の場合だけ埋め込み本文を使用する。未許可では概要のみを保存する。取得許可は自動で変更しない。
- 本文許可済みでも概要・切り詰め本文しかなければ、既存のrobots・スコープ検査の下で記事ページの取得を試みる。失敗しても切り詰め本文を完全な本文とは扱わず、後日の再試行対象に残す。
- Atomの `published` と `updated` を分け、更新日しかない記事の公開日を推測しない。

## 回帰テスト

`tests/rss-content.test.ts` は本文優先順位、空値、HTML、概要分離、上限境界を検証する。

`tests/rss-fulltext-integration.test.ts` は隔離したSQLiteと実際の検索APIを使用し、次を検証する。

- 10記事中、概要では1記事、長い本文も保存すると2記事で対象語が見つかること。
- 同じ記事の再収集でID・初回取得日時・保留状態・保存済みカードとメモを維持すること。
- 形態素解析・N-gramの両トークンキャッシュが更新されること。
- サイトの本文許可前後、切り詰め本文の再試行、Reader保存本文の保護。
- Atomの概要・公開日・更新日、相対リンク、登録範囲外のリンク除外。

比較調査時に別途保存した実RSSを再生するテストも用意した。本文をリポジトリへ追加せず、ローカルファイルを環境変数で指定する。

```powershell
$env:RSS_REGRESSION_FEED_FILE = '保存済みcommon-feed.xmlの絶対パス'
node node_modules/vitest/vitest.mjs run tests/rss-content.test.ts tests/rss-fulltext-integration.test.ts tests/collector-review.test.ts tests/sites.test.ts tests/site-integration.test.ts tests/discover.test.ts --fileParallelism=false
```

指定がない場合は実RSS再生だけをスキップする。実データ例はDaniel Stenbergのフィード10記事中、`CVE-2026-92392` が本文に存在する2記事の検索を確認するものであり、一般的な検索精度・再現率を示す評価ではない。

## 制約

- フィードの `fulltext` は「配信された本文を切り詰めず保存した」という意味であり、元ページ全体との完全一致や利用許諾を保証しない。Atomの `content` だけの場合も保守的に `excerpt` とする。
- 概要しか配信しないフィードから、それだけで全文を復元することはできない。サイトの取得許可とページ取得の成否に依存する。
- 過去の記事がフィードから消えていれば、この修正だけでは再取得できない。
- 既存DBの一括書き換えは実行しない。通常の再収集、または本文許可済みサイトの再同期で、現在取得可能な記事から更新される。
- 100,000文字の本文をKuromojiへ一括投入すると、同一Windows環境の単体計測で116,662msかかった。`tokenizeMorphological` は8,192文字以下のチャンクに分け、直近の空白・句読点境界を優先して処理する。100,080文字の「Background. 」反復ではテスト内6,712msとなり、約94%短縮した。これは単一の人工英文での処理時間比較であり、一般的な文書すべての性能保証ではない。安全な境界が見つからない非常に長い連続文字列では、チャンク境界で形態素分割が変わる可能性がある。N-gram生成は従来どおり元の全文字列に対して行う。

## 検証状況

最新確認（2026-10-23）:

- `npm.cmd run typecheck`: pass
- `npm.cmd run build`: pass、97 files built
- `npm.cmd run acceptance:test`: 47 test files passed、367 passed、1 skipped、0 failed。RSS長文統合ケースは9,597msでpass。
- Chromium Playwright: 保存カード検索UI経由の2ケース pass（BM25 UI検索、重複排除既定の互換性）。
- `tests/tokenizer.test.ts`: 5/5 pass。100k超長文トークナイズの回帰を追加。
- 標準BM25 / Movies・Books比較は探索的開発データであり、FTS5/RRFの安定した優位性や独立最終評価を示さない。詳細は `saved-card-search-fts5-validation-2026-10-22-ja.md` を参照。
