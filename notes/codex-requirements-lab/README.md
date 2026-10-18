# Codex Requirements Lab — 10ケースの要求分析実験

OpenAI APIキー・外部ライブラリ不要。Codexの作業ディレクトリとして**このフォルダのみ**を開く。

## Codexに送る指示

`AGENTS.md を読んで tasks/run-benchmark.md を実行してください。10件すべて output/TCxx/report.json に出力し、node scripts/check-all.mjs で検証してください。`

## 自分で構造検証する

```bash
node scripts/check-all.mjs
```

出力は各ケース `output/TC01/report.json` ... `output/TC10/report.json`。形式検証以外の採点はこのフォルダでしない。

## 独立評価

このワークスペースとは別に配布している `requirements-evaluator.zip` を展開し、結果ができてからそちらで評価する。採点基準を分析実行時に見せると評価が汚染されるため、別フォルダ・別Codexセッションで実施する。

## 設計意図

- `unknowns` を `requirements` から分離（前回の課題への対応）
- 検証方法に `metric`・`decision_rule` を追加
- 要件の上位目的 (`goal_ids`) と検証対象 (`related_ids`) の参照を管理
- 外部ライブラリのない検証スクリプトを添付

※ 「10件」は不具合を発見するための小規模な探索的評価。統計的な一般化・商用利用での品質保証には不足。
