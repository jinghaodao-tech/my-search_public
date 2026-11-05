# 検索品質改善・統計評価レポート（2026-10-21）

## 要約

- 開発データでは英語クエリのストップワードと先頭の `[TOMT] [Book]` 等を整理し、Books Hit@10 は 96/262 から 105/262 に改善した。Books検証234件でも69から74へ増えたが、この検証セットは過去に使用済みで、独立な有意性の証拠ではない。
- 未使用のMovies検証群では検索モードの選択が大きく影響した。既定 `impl` は 19/292、用途説明に適合する `theory` は 63/276。後者と独立標準BM25との差は確定せず、標準方式より優れるという主張はできない。
- 現実の保存記事の検索セッションは0件。実利用95%評価は **NOT_EVALUABLE**。TOMTスコアは実利用率ではない。
- 既存カードDBは読まず、評価用SQLiteだけを作成した。commit/pushなし。

## 原因分析

### Books開発セット

固定200対象群、262クエリ、全1,910文書を使用。コード修正前後とも独立標準BM25との比較は形態素トークン、k1=1.2、b=0.75、同一qrelsで行った。検索APIではなく `runPipeline` の直接診断である。

| 指標 | 修正前 | 修正後 |
|---|---:|---:|
| Hit@1 | 44/262 (16.8%) | 53/262 (20.2%) |
| Hit@10 | 96/262 (36.6%) | 105/262 (40.1%) |
| MRR | 0.2381 | 0.2625 |
| Hit@100 | 162/262 (61.8%) | 161/262 (61.5%) |
| Hit@1000 | 232/262 (88.5%) | 235/262 (89.7%) |
| 標準BM25 Hit@10 | 76/262 | 92/262 |

修正前のTop10 miss 166件のうち163件は正解文書に少なくとも一部の形態素キーワードがあり、3件だけは対象文書との形態素・N-gram一致がなかった。主因は「正解文書が候補にない」より、クエリ語のノイズとランキングである。修正後は先頭タグの除去と一般英語ストップワード除外でHit@10が増えた一方、診断上、正解文書に語彙一致が見つからないケースが3件から20件、検索候補のTop1000内に正解がないケースが30件から27件となった。過度な除外を避ける回帰監視が必要。

Books検証234件は既に探索に使用済みのため参考値のみ: Hit@1 34→34、Hit@10 69→74、Hit@100 132→129、Hit@1000 210→208、MRR 0.1973→0.2004。独立検証・p値とは扱わない。

### Movies未使用検証サンプル

以前の確認済み200群と今回の `impl` 評価200群を除外し、さらに200群/276クエリを事前固定した。全8,845文書を隔離SQLiteに投入し、アプリAPI経路を実行。正解、基準値は変更していない。

最初の計画どおり「最初のモード」を使うと `impl` になった。これはコード・実装向けモードでBooks/Moviesの回想質問に適さない。19/292 (6.5%) で、独立標準BM25は71/292 (24.3%)。対比較は標準BM25のみ成功52件、アプリのみ成功0件、同点240件。200対象群で標準BM25が優位46群、アプリ優位0群、同点154群。クラスタ差（アプリ−標準）は−17.47ポイント、95% cluster-bootstrap CI [−23, −13]ポイント。事前登録の「アプリが優れる」片側p=1.0、検出力推定0%。この比較はAPI既定モードの測定であり、文学・一般検索機能の評価としてはモード不適合の交絡がある。

そこでその標本を再利用せず、説明上適合する `theory` モードについて、残りの未使用群から別の200群/276クエリを固定して計測した。

| 指標 | theoryモード/API | 標準BM25（独立実装） |
|---|---:|---:|
| Hit@1 | 21/276 (7.6%) | 36/276 (13.0%) |
| Hit@10 | 63/276 (22.8%) | 74/276 (26.8%) |
| MRR@10 | 0.1171 | 0.1760 |
| Hit@100 | API既定応答では未観測 | 120/276 (43.5%) |
| Hit@1000 | API既定応答では未観測 | 196/276 (71.0%) |

群単位のHit@10差は−1.89ポイント、95%クラスタ・ブートストラップCI [−7, +4]ポイント。事前登録方向 `theory API > standard BM25` の片側符号反転p=.751、事後近似検出力は約1%。200群で差を確定する力がなく、どちらの方式も95%目標から遠い。標準方式の上位1000分布はTop10 74、11–100が46、101–1000が76、1000位外が80群クエリ相当で、8件は語彙一致候補なし。文書が情報を含むか、qrelsが曖昧かを個別確認しないまま、残りを「ランキング不良」と断定しない。

## 改善ループ

1. **採用**: 英語機能語の除外と先頭の角括弧メタデータ除去。Books開発Hit@10 +9、MRR +0.0244。使用済みBooks検証の記述統計も同方向。ただしBooks固有の改善で、Moviesへ一般化したとは言えない。
2. **不採用**: RRF60。Books開発でHit@10 103/262となり現行修正後の105/262を下回ったため、製品ランキングには加えない。
3. **保留**: 独立標準BM25。Movies theoryの点推定は標準側が高いが、クラスタCIは0を含み、事前登録pも有意でない。検証データに合わせたランキング切替は行わない。
4. **評価手順修正**: `benchmark_api.py` に `--mode-id` を追加。Books/Moviesの適合モードを明示できるようにした。製品モードやBM25係数は変更していない。

ここで係数を調整して同じ検証セットを再使用することはしない。次の開発反復はMovies開発セットまたは利用者の実カード/実検索語が必要。

## レイテンシ・メモリ

| 実行 | p50 | p95 | 解釈 |
|---|---:|---:|---|
| Movies impl API | 2,484.9 ms | 3,044.7 ms | 検索語解析＋API＋DBロードを含む |
| Movies theory API | 2,472.6 ms | 2,979.2 ms | 同上 |
| 独立BM25インメモリ計算 | 43.37 ms | 86.22 ms | 事前ロード済みトークンでBM25処理のみ。API値と直接比較不可 |

サーバーログでは1リクエストあたり全カードロードに約0.87〜1.14秒。APIプロセスの観測RSSは約1.93GB、評価DBは約116MB。コーパス投入時Node RSSは最大約1.68GB。これはこのWindows環境での観測で、厳密な常駐ピーク計測ではない。検索ごとの全件ロード・統計構築が速度/メモリ上の主要な改善候補。APIエラーは両Moviesサンプルで0件。

## 実利用評価

- 検索調査UIのブラウザE2E: Chromium 1件成功。同意確認、検索開始前の参加停止、撤回ボタンのリクエスト、ローカル同意状態削除を確認。実クエリ/参加者/正解は作っていない。
- APIテストは同意必須、検索開始時点に存在したカードだけを正解にできること、重複参加者拒否、撤回時の生データ削除、アーカイブ済みデータ保持、保持期限後の生記録削除、ループバック判定を確認。
- CLIとAPIで保持期限を検査し、期限切れ時は検索語等の生データを削除して非識別の期限状態だけを保持する。自動削除はAPI/CLIが実行された時に限られ、ローカル暗号化は未実装。保護境界は同一PC/OSユーザーであり、参加者の実在・同意はソフトウェアで証明できない。
- `quality/e2e/study/` に実利用セッションなし。したがって実利用状態は **NOT_EVALUABLE**。
- 初回試行の計画は500人から各1件。各成功指標で少なくとも485/500成功が必要。2指標とも個別に基準を満たす必要がある。1人500回は一般化の証拠にならない。

## テストと制約

- `npm run typecheck`: PASS
- Vitest: `tests/query_analysis.test.ts`, `tests/bm25.test.ts`, `tests/refind_study.test.ts` — 28 passed
- Playwright: `e2e/refind-study.spec.ts` — 1 passed（Chromium、同意・参加停止・撤回）
- `quality/e2e/tests/self_test.py`: 6件 PASS（隔離/模擬データのみ）
- `quality/e2e/internal_refind/tools/self_test.mjs`: PASS
- 公開ベンチマークは特定ドメイン・長文回想クエリであり、自然な日本語保存記事再発見に外挿できない。Moviesの2回目は未使用対象群だが同じ既知データソース・validation splitで、完全に独立した外部コーパスではない。
- Movies APIの通常応答は上位50件の設定で、今回の計測はTop10まで。アプリTop100/Top1000は未測定。標準BM25は独立オフライン全件採点で上位1000まで測定。

## 変更ファイル

- Query parsing: `services/query_analysis.ts`, `services/discover_service.ts`, `tests/query_analysis.test.ts`
- Study retention/consent E2E: `routes/refind_study_routes.ts`, `quality/e2e/tools/live_study.py`, `public/js/search_screen_ui.js`, `playwright.config.ts`, `tests/refind_study.test.ts`, `quality/e2e/tests/self_test.py`, `e2e/refind-study.spec.ts`, `quality/e2e/docs/STUDY_PROTOCOL.md`
- Evaluation tooling and preregistrations: `quality/e2e/tools/diagnose_ranking.ts`, `quality/e2e/tools/prepare_group_sample.py`, `quality/e2e/tools/benchmark_api.py`, `quality/e2e/tools/standard_bm25_from_seeded_db.ts`, `quality/e2e/tools/analyze_clustered_comparison.py`, `quality/e2e/docs/MOVIES-UNUSED-VALIDATION-PREREGISTRATION-2026-10-21.md`, `quality/e2e/docs/MOVIES-THEORY-MODE-PREREGISTRATION-2026-10-21.md`
- Frozen results/manifests: `quality/e2e/artifacts/movies-unused-validation-2026-10-21.json`, `movies-theory-validation-2026-10-21.json` と各API/標準BM25/cluster分析JSON。
