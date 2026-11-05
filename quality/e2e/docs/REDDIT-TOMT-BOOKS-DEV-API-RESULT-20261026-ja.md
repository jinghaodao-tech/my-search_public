# Reddit-TOMT Books 現行API開発評価

実施日: 2026-10-26。目的は人間由来の既知項目質問で保存記事検索APIの探索的な基準値と、語重みプロファイルの差を測ること。これは書籍コーパスの開発結果であり、ニュース記事検索の一般品質や最終95%達成を示さない。

## 固定条件

- 出典: Reddit-TOMT Books。正規化済み1,910冊、開発質問1,842件、正解対象グループ1,528件。
- 配布ZIP SHA-256: `7c4585a9ca18bd26c4040c478d7099c9942ad6bf59462ff602d24d101e4daf03`。
- 既に方式探索に使った同一データであり、結果は開発用。過去に消費したholdoutは再利用しない。
- 隔離した一時SQLite DBを使用。準備後の検索は実API `POST /api/search/terms` → `POST /api/cards/search` を逐次実行。APIエラー・タイムアウトは失敗として扱う。
- API実装識別: Git HEAD `be29373f0381c1b58af329932190b56c86f20819`、source fingerprint `sha256:dc4ed06ddd9c87880ababb3bb6f34cef4a17fecab445e9685dec558022648167`、mode `impl`。
- この全開発質問プロファイルは `dedupThreshold=0.8`。現在の `/api/cards/search` は `dedupThreshold < 1` だと形態素FTS5索引を使わずBM25経路へフォールバックする。別記録の100問エンジン比較では `dedupThreshold=1` を使ってFTS5経路を測っているため、22.20%と同じ100問比較のFTS5 44%を直接の方式差として解釈しない。
- 95%区間は `group_id` 単位で復元抽出するpercentile cluster bootstrap、1,000反復、seed `20261026`。API処理時間は自然文の解析から上位10件返却まで。
- 生質問、コーパス、全件単位の結果はGit除外領域 `quality/e2e/local/` に保管し、公開しない。

## 結果

| プロファイル | Hit@10 | group bootstrap 95% CI | APIエラー | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| 現行 | 409/1,842 (22.20%) | 20.27–24.13% | 0 | 212.5ms | 322.5ms |
| 英語ストップワード除去 | 407/1,842 (22.10%) | 20.12–23.99% | 0 | 213.4ms | 331.9ms |
| 均等語重み | 407/1,842 (22.10%) | 20.12–24.03% | 0 | 215.8ms | 335.4ms |
| 形態素重み強化 | 425/1,842 (23.07%) | 21.16–24.99% | 0 | 214.6ms | 336.8ms |
| n-gram重み強化 | 406/1,842 (22.04%) | 20.13–23.95% | 0 | 207.3ms | 332.1ms |

この5設定では形態素重み強化が最多で、現行から16問増えた。区間が大きく重なるため改善の確証とは扱わず、同じ開発データで追加調整もしない。各設定のp95は500ms未満だが、文書数は1,910件なので1万件の性能目標を再判定する値ではない。

再現用のaggregate-only集計器:

```powershell
& 'C:\Users\jingh\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  scripts/bench/summarize_api_benchmark.py `
  quality/e2e/local/reddit-tomt/books/development-profiles-20261026.json `
  --bootstrap-samples 1000 --seed 20261026
```

このコマンドは集計値だけを標準出力し、検索文や個別結果を出力しない。
