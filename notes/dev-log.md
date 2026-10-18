---
title: my-search 開発ログ
template: dev-log-v1
updated_at: 2026-08-21
---

# my-search 開発ログ

ADRとは分離し、検索・カード・AIジョブ・UI・E2Eの実装と検証を記録する。

## 主要な実装・検証

- BM25／token cacheを中心に検索処理を整理し、検索品質評価の土台を追加。
- `precisionAt`、MRR、理論上限の定義を標準定義に合わせ、k件未満の結果を正しく減点する回帰テストを追加。
- API route、service、repositoryの境界を整理し、OpenAPIとエラー契約を更新。
- Candidate lifecycle、archive、Invalid Date修正、SQLite migrationを実装・検証。
- AI jobの状態遷移、重複起動、status、監査情報をテスト。
- Browser／HTTP E2Eでカード作成、検索、レビュー、連続保存を確認。
- モバイル機能を現役機能から除外し、READMEとcurrent-product-specの説明を整合。
- `docs/e2e.md`にChromium sandbox固有の失敗条件と対処を記録。

## 検証上の注意

- 検索品質の数字は評価クエリセットとコーパスに依存する。
- WindowsのCRLF差分や一時ファイルを、実質的なコード差分と混同しない。
- 外部AIやブラウザ実行を伴うテストは、環境依存の失敗を分離して記録する。

## 今後の追記形式

```markdown
### YYYY-MM-DD: 作業名
- 目的:
- 変更ファイル:
- 評価クエリ／テスト:
- 結果:
- 未確認／残課題:
- commit／push:
```
