# タスク：要求分析ベンチマーク10件

`AGENTS.md` を読み、以下を順に実行する。

1. `cases/TC01.txt` から `cases/TC10.txt` をそれぞれ独立した顧客案件として扱い、混ぜずに分析する。
2. `schemas/report.schema.json` に従い、各ケースの `output/TCxx/report.json` に保存する。
3. `input` は元の入力テキストを改変せず記録する。`case_id` は TCxx に一致させる。
4. 検証は実施していないので `verification[].status = "planned"` を使う。
5. `node scripts/check-all.mjs` を実行。形式・参照のエラーがあれば修正して再実行する。
6. `output/run-notes.md` に所要作業の概要、成功件数、構造検証での修正、未解決事項を書く。

**注意:** このワークスペースの外側にある「正解・採点用ルーブリック」を探索しない。出力された分析を自己採点しない。改修や実装はしない。
