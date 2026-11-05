# my-search リポジトリ実行検証（2026-10-23 再実行）

既存の未コミット変更を保持し、追跡済みのテスト結果JSONを上書きしない方法で再実行した。ベンチマークとE2Eは専用の隔離SQLiteを使用した。

## 実行結果

| 検証 | 結果 |
|---|---|
| `npm.cmd run typecheck` | PASS |
| 焦点Vitest: cards / article FTS / MIRACL metrics / refind study / RSS integration | localhost許可後 5 files、51 passed、1 skipped、0 failed。sandbox内の初回はlocalhost `EACCES` |
| 全Vitest `npx.cmd vitest run tests --pool=threads --fileParallelism=false` | 48 files、376 passed、1 skipped、0 failed |
| 全Playwright `npx.cmd playwright test --workers=1` | 専用port 3197・新規隔離DBで12/12 PASS |
| `npm.cmd run check:frontend` | PASS |
| `npm.cmd run check:verification-artifacts` | PASS |
| `npm.cmd run check:encoding` | PASS |
| `npm.cmd run check:openapi` | PASS、必須10項目 |
| `npm.cmd run verify:schema`（隔離DB） | PASS、12 tables、foreign key違反0、integrity `ok` |
| `npm.cmd run check:search-index`（隔離DB） | PASS、カード233・FTS233、欠落/孤児/token欠落0 |
| `npm.cmd run check:saved-card-search-index`（隔離DB） | PASS、形態素/N-gram/raw各233 |
| `npm.cmd run check:article-search-index`（隔離DB） | PASS、記事0・両索引0・欠落token0 |
| `git diff --check` | whitespace errorなし。既存CRLF→LF警告のみ |

## 保存カードAPI比較

`node_modules/.bin/tsx.cmd scripts/benchmark_saved_card_search_fts.ts data/saved-card-search-repo-verification-20261023-02.sqlite artifacts/saved-card-search-repo-verification-20261023-02.json` を実行した。233件の匿名化トークン文書、手書きクエリ30件。両方式ともAPIエラー0。

| 指標 | 既存BM25 | FTS5-RRF |
|---|---:|---:|
| Hit@1 | 0.700 | 0.700 |
| Hit@10 | 0.900 | 0.933 |
| R-Precision | 0.6944 | 0.6944 |
| MRR@10 | 0.7733 | 0.7803 |
| Recall@5 | 0.8889 | 0.8889 |
| nDCG@5 | 0.7924 | 0.7947 |
| API p50/p95 | 35.13 / 89.47 ms | 17.89 / 37.33 ms |

対応Hit@10はFTS5-RRFのみ成功1、BM25のみ成功0、同値29。両方式を同じプロセスで実行した終端RSSは556,032,000 bytes、heapUsedは193,818,328 bytes。ピーク値・方式別増分ではない。前回と同じ開発用30件の再現比較であり、独立評価ではない。

成果物:
- `artifacts/saved-card-search-repo-verification-20261023-02.json`
- `data/saved-card-search-repo-verification-20261023-02.sqlite`（隔離DB）
- `quality/e2e/artifacts/repo-sequence-e2e-20261023-02.sqlite`（E2E隔離DB）

初回sandboxベンチはlocalhost `EACCES`で終了した。起動時に作られた `data/saved-card-search-repo-verification-20261023.sqlite` は削除せず保持し、匿名fixture投入後に完走したのは `-02` DBだけである。E2Eの最初のDB名は存在確認で開始前に拒否され、既存DBは変更していない。

## ユーザーデータと評価境界

本番 `data/cards.db` は読み取り専用の索引検査で cards/FTS各234、欠落・孤児・token欠落0。ファイルサイズ5,652,480 bytes、更新時刻 `2026-10-23 04:22:45 UTC` で、今回の実行後に更新された形跡はなかった。実行中サーバーがファイルを開いていたため、この時点のSHA-256取得はOSに拒否された。全内容の事前ハッシュ比較を行ったとは主張しない。

MIRACLのHit@10評価器不具合は既存コードの回帰テストで確認済み（11位はHit@10/MRR@10に含まず、Hit@50には含む）。消費済みholdoutのcheckpoint訂正はpost-hoc監査であり、独立検証ではない。今回726クエリのAPI再生、実返却件数の分布、11〜50位の順位は未測定。新しい独立代表クエリと正解が不足しているため、独立統計評価と保存記事の実利用成功率は `NOT_EVALUABLE`。

`npm run verify`全体、`npm audit`、Docker buildは今回再実行していない。`verify`には既存のtracked成果物を上書きする工程があり、Docker/監査は別途の運用検証が必要。過去の作業記録にあるnpm auditの脆弱性結果とDocker未確認状態を今回の新しい測定結果として流用していない。既定ランキング・本番設定は変更せず、commit/pushなし。
