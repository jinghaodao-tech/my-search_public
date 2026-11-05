# Codex向け・一回の依頼で4段階を進める完全指示（my-search）

以下を、`my-search`リポジトリの `quality/e2e/` にこのZIPの中身を配置した状態で実行せよ。**質問せずに実行可能な作業を先に進める。** 実利用者が必要な箇所だけ、人が必要であることを明示し、**待っているふりや架空の成果を出さない。**

## 最終的に何を達成したいか

my-searchが保存済み記事を探し直す際の失敗を減らす。**(1) 実際の人間のうろ覚え質問を含む公開データで検索品質を評価→(2) 失敗分析と一般化可能な改善を段階的に自動反復→(3) 未使用データで検索品質を一回だけ統計判定→(4) my-search実利用者の自然な再発見セッションを計測・統計判定**できる仕組みを作り、可能な範囲まで実行する。

「公開データで95%」は「my-searchの保存記事を実際に再発見できる確率95%」とは別。後者は真の利用者の試行なしには判定してはならない。

## 最初の確認

- `git status --short`、現行ブランチ、未コミット変更、DB接続、`routes/cards_routes.ts`、`repositories/cards_repository.ts`、`db/database.ts`、既存品質テストを確認する。公開GitHub mainではなく**このローカル作業ツリーが正本**。
- `quality/e2e/README.md`、`docs/DATA_SOURCES.md`、`docs/STUDY_PROTOCOL.md` を読み、変更しない独立保持評価と開発評価の区別を理解する。
- 既存のSQLiteファイル、Reader、カード、メモ、ユーザーデータに**破壊的操作を行わない**。新規記事源・有料AI・外部検索APIは勝手に導入しない。初期状態のメトリクスとレイテンシは記録する。
- 原則、追加するコードは保存カード検索・品質評価・任意参加の実利用測定だけに限定。commit/push/PRは禁止。

## 第1段階：公開の自然な問いと正解アイテムによるベースライン

1. Python 3.10+、Node.js、`npm ci` 済み依存を確認。`python quality/e2e/tests/self_test.py` と `node quality/e2e/internal_refind/tools/self_test.mjs` が動くことを確認する。
2. 公開実データを公式配布元から取得する（データが取得できなければ**代替として合成データを本番スコア扱いしない**）:
   ```bash
   python quality/e2e/tools/get_tomt.py --domain Books
   python quality/e2e/tools/get_tomt.py --domain Movies
   ```
   元データは本ZIPに含まない。`data/reddit_tomt/{books,movies}/provenance.json` で由来、原本SHA256、文書数、自然な検索質問数、正解IDと分割数を確認する。Booksから始め、時間や容量制約があればMoviesは未実行を明示する。
3. `/api/cards` の**本物の実装**を、隔離した新しいSQLite上で起動し、書籍/映画の説明文書をAPIで投入して評価する。既存の個人DBに混ぜない。エンジン比較に必要な検索対象のコーパスを必ず揃え、正解IDが存在することを検証する。
   ```bash
   python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/books --stage development --out quality/e2e/artifacts/books-dev-baseline.json
   python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/books --stage validation --out quality/e2e/artifacts/books-validation-baseline.json
   ```
4. 第1段階では、別途 `internal_refind` のローカルAPI回帰348件も使用する。**この348件は保存カード由来・合成なので、自然な再発見の統計証拠にしない。** `04_holdout` は最終まで開かない。
5. 検証項目：Hit@1/Hit@10、未発見、類似文書に負けた順位、曖昧な固有名詞・同義語・長文、失敗率、検索時間p50/p95、既存API回帰・文字エンコード・日本語検索。

## 第2段階：最大12回の自動反復改善

1. **developmentだけを詳細な失敗分析に使う**。`validation`は各候補の選択判断まで。`holdout`や真の実利用研究のクエリ・ラベルは開発に絶対使わない。
2. `n=1..12` のループで：失敗分類→**一般化する一つの修正**→型チェック/ユニット/セキュリティ/回帰→隔離DBで再測定→指標・時間・退行を記録する。クエリ文や正解IDへのハードコード、データの編集、評価器・しきい値のすり替え、回答文書の検索語への混入は禁止。
3. 比較は、同一データ・同一splitのreportsを `python quality/e2e/tools/compare.py before.json after.json` で**対応あり**評価する。開発用に繰り返し見た検定p値を最終認定と呼ばない。改善成功と退行の件数を両方記録する。検索時間、保存更新後のインデックス整合性、SQLiteトランザクション、`CARD_SEARCH_ENGINE`分岐と後方互換性を検証する。
4. 追加ゲートとして、ローカルの保存カード検索が起動できるなら：
   ```bash
   node quality/e2e/internal_refind/tools/make_live_title_cases.mjs --base http://127.0.0.1:3000 --out quality/e2e/internal_refind/cases/01b_live_titles.json
   node quality/e2e/internal_refind/tools/run_stages.mjs --base http://127.0.0.1:3000 --out-dir quality/e2e/artifacts/internal-after
   ```
   ただしテストケースに記載のカードが存在しない環境では `missing-target` を明示し、そのケースで性能を判定しない。134件の過去データの「実行済み」を現在のAPIに対する新たな実測と混同しない。
5. 事前ルール：前回の良好な結果を維持できない変更は戻す。開発/検証改善が連続3ラウンドで出ない、深刻な速度退行がある、12反復を完走、のいずれかで停止。目標未達でもテストや正解を改変して合格にしない。

## 第3段階：未使用の自然クエリで一度だけ最終評価

1. 最後に**検索エンジンのコードと設定を凍結**して `python quality/e2e/tools/fingerprint.py --repo .` でソース指紋を残す。実行環境・Card DBの差分・コーパスの原本SHA256を記録。
2. `data/reddit_tomt/books/holdout.jsonl` と（実行できれば）movies holdoutは**修正中は内容も正解も見ない**。最終評価だけ、以下のように一回実行する（`--final`必須、同出力フォルダでの再実行防止）:
   ```bash
   python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/books --stage holdout --final --out quality/e2e/artifacts/books-final/holdout.json
   ```
3. 独立同分布と事前固定の前提のもと、正確二項分布による片側97.5%信頼下限が95%を上回るか判定する。サンプル数が少なすぎる/偏りが大きい場合や、対象ドキュメントが欠けている場合は認定を控える。再調整する場合、このホールドアウトを再度「未使用」にしない。新しい独立試験を採用しα消費を記録。
4. 認定が成立しても主張は**Reddit-TOMTの書籍/映画検索評価に限定**。真のmy-search記事保存・再発見率と同一視しない。未使用データを見た後で都合よく閾値を変更しない。

## 第4段階：実利用の再発見セッションを前向きに集める機能を実装

1. `docs/STUDY_PROTOCOL.md` に従い、明示同意・任意参加・デフォルトOFFのローカル収集画面/機能を実装する。テスト用ダミー参加者やAIが生成した人の発言を入力データに採用しない。
2. **検索開始時点**の最初のクエリ、Top10カードID、応答エラー、発生時刻、ビルドID、対象カード集合情報を記録する。後日の同じクエリ再実行結果での採点は禁止。再検索回数、目的カードを実際に開いたイベント、開くまでの時間、タイムアウトも記録する。
3. 保存済みターゲットを結果表示後に**人間が指定・確認**し、対象が検索前から保存されていたか照合する。不明・失敗も分母に残す。言い換え生成、タイトル抜き出しは自然ログにならない。実利用の秘密・検索語を外部送信しない。削除/撤回手段とローカルのみのデータ保存を備える。
4. CLIの最小実装は既にある。必要ならUIの記録結果をこのログ構造と等価なイベントへ保存できるように拡張するが、統計判定プログラムを「通るように」緩めてはならない:
   ```bash
   python quality/e2e/tools/sample_plan.py --n 500 --true-rate .98
   python quality/e2e/tools/fingerprint.py --repo .
   python quality/e2e/tools/live_study.py init --build-id <指紋> --scope multi-user --n 500 --population "事前登録した同意済み対象集団"
   python quality/e2e/tools/live_study.py progress
   # 参加者自身の自然な再発見の際のみ：
   python quality/e2e/tools/live_study.py record --participant <匿名ID> --build-id <指紋>
   # 結果を後から人間が照合。--opened-card/--seconds/--queries は実測値、作り話禁止。
   python quality/e2e/tools/live_study.py resolve --sid <試行ID> --gold <対象カードID> --human-checked --opened-card <開いたカードID> --seconds <実測秒数> --queries <実検索回数>
   # 開けなかった場合は --not-opened を指定。正解不明なら --unknown。
   # 事前登録n件 + 全件の判定が済んで初めて:
   python quality/e2e/tools/live_study.py seal
   python quality/e2e/tools/live_study.py certify
   ```
5. 同じ参加者が複数回入力した500回を「500独立ユーザー」と偽ってはならない。対象ユーザー数が足りないなら `NOT_EVALUABLE` とする。個人のみの研究なら `personal-longitudinal` と明示して一般利用者向け認定を禁止。データがあっても代表性・独立性は別途検討し、その限定を報告。
6. `Hit@10` と実際に**180秒以内・3検索以内で目的カードを開いた割合**を分けて採点。両方で真の95%超を支持できる場合だけ、事前登録された限定母集団に対して条件付き認定する（必要条件は各指標の片側正確信頼下限>95%）。片方だけ達成したら全体認定しない。
7. スクリプト自体の模擬データによるテストは行うが、真の実利用データがまだなければ、完成報告は**`IMPLEMENTED_AWAITING_REAL_USERS` / `NOT_EVALUABLE`**。架空の500件や「統計的に証明済み」を出力しない。

## 最終レポート（必須）

- 実際に取得した自然クエリ数、対象文書数、正解数、原本のデータSHA256、テスト分割ごとの件数。
- 検索エンジンのベースライン→反復ごとのHit@1/10、対応あり改善数/退行数、レイテンシ、失敗原因、コード変更と安全性検証。観測していない数値は「未計測」。
- 未使用ホールドアウトでのn、成功数、95%超に対する片側信頼下限とp値、公開ベンチマークに限定した結論。未達なら明確に未達と書く。
- 実利用の事前登録コホートn、実登録セッション数、**真の**同意済み独立参加者数、成功数、2指標の統計判定、標本の代表性と研究の弱点。データがなければ `NOT_EVALUABLE` で終了。
- 実施した検証コマンドの実出力、追加・編集ファイル、既存データ破壊なし、未解決点。無断のcommit/pushは禁止。

## 不正防止の絶対規則

- 元の自然クエリを合成で補完して母数に入れない。データ取得不能は取得不能として記録する。
- 以前見た正解ID・ホールドアウト結果をコードにハードコードしない。検定閾値やnを結果を見て変更しない。
- 最終評価で失敗した後、同じホールドアウトを使って改善して再度「統計的に初回判定」と書かない。
- プログラムによる `git` 指紋やハッシュ連鎖は真正な人間・代表性を保証しない。その制約を記載する。
- 初期に用意した既存348件は退行検出だけに使用。実データに相当するものではない。
