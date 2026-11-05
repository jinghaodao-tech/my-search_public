# 入出力スキーマ（サンプルの値は架空）

## 自然データ取得後のファイル

`data/reddit_tomt/books/documents.jsonl` （実際の取得・変換時に生成される）

```json
{"id":"Books:upstream-document-id","title":"title from source","body":"source description","source":"Reddit-TOMT:Books"}
```

`data/reddit_tomt/books/development.jsonl` と `validation.jsonl`、`holdout.jsonl` は同じ形。

```json
{"id":"Books:upstream-query-id","query":"human question, without answer replies","source":"reddit-human-recollection","gold_ids":["Books:upstream-document-id"],"group_id":"Books:upstream-document-id","split":"development","original_split":"train"}
```

これらはスキーマ例であり、自然に発せられたクエリの**実データではない**。公式データ取得後に生じた `provenance.json` の件数とSHA256を記録する。

## 開発ステージ結果

`artifacts/books-dev-baseline.json` は次を含む。

- `stage`, `dataset`, `domain`, `source_sha256`, `build_git_head`, `isolation`
- `stats`: `n`, `successes`, `observed`, `lower_exact_one_sided`, `p_value_H0_at_threshold`, `passes`
- `hit_at_1`, `latency_ms_median`, `latency_ms_p95`
- `all_results`: 各クエリの `qid`, `rank`, `success`, `latency_ms`, `status`
- `diagnostic_only`: `--max-queries` を使った場合は必ず `true`。統計認定に転用しない。

## 実利用セッションのログ

`study/protocol.json` に最初に計画した人口・n・ビルド指紋などが保存される。

`study/events.jsonl` は追記専用の形式で次の2種類のイベントを持つ。

1. `session`: `sid`, `participant`, `query`, `build_id`, `top10`, `error`, `latency_ms`, `at`, `hash`, `previous_hash`
2. `adjudication`: `sid`, `gold_id`, `status`, `opened_card_id`, `elapsed_seconds`, `query_count`, `reviewed_by_human`, `at`, `hash`, `previous_hash`

UI統合時には同等の監査可能なイベントを作る。CLIのハッシュ連鎖は意図しない編集の発見用で、故意の改竄防止や実在する人間の存在証明にはならない。認定に足りない場合は `NOT_EVALUABLE` と出す。

## 保持規則

- コミットしない：`data/reddit_tomt/`, `study/`, `study_archive/`, `artifacts/`。
- 再利用不可：未使用ホールドアウト、一度判定した実利用コホート。
- 元データを公開・再配布する前に投稿者の権利と公式配布条件を確認。
