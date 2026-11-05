# my-search 4段階自動改善・統計評価キット

2026-10-25の目標と2026-10-26の評価スコープ整理は[検索目標](../../docs/search-goals-ja.md)を参照してください。一般性能の主評価は人手由来の外部ベンチマーク、本人の保存庫に対する個別評価は[個人向け再発見評価プロトコル](docs/PERSONAL-REFIND-PROTOCOL-ja.md)で分けます。旧キットの複数人・信頼下限による統計認定は別プロトコルであり、旧ツールの合否をそのまま新目標の達成判定に使わないでください。

新目標向けの任意ローカル収集はmy-searchの検索画面に統合され、`npm run personal-refind:init` でGit除外領域に準備します。参加チェックは初期OFFで、同意前の検索を収集しません。アプリは最大300件の自然なカード検索を記録し、エクスポーターは適格な最初の100問を最終評価用に出力します。旧 `tools/live_study.py` は別の複数人研究プロトコルのままです。

**目的：一回のCodex指示で、(1)公開自然クエリの取得と評価→(2)コード改善の反復→(3)未使用データでの統計的な検索品質判定→(4)実利用者の検索セッション収集機能の実装と、取得済みデータがあれば統計判定、まで進める。** 人間が実際に利用した検索記録をAIが偽造して工程4の合格にすることは禁止。

## すぐ使う

1. ZIPを展開し、フォルダをリポジトリ直下の `quality/e2e/` に配置。
2. Codexに [CODEX_ONE_SHOT.md](./CODEX_ONE_SHOT.md) 全文を渡すか、次の文章を一度だけ送る:

> `quality/e2e/CODEX_ONE_SHOT.md` に従い、4段階を自律的に実行してください。実データを取得し、隔離DBで計測、最大12反復改善、未使用ホールドアウトで一度だけ評価、任意参加の自然な再発見セッション収集・統計判定UIを実装してください。実際の利用者データがない場合は収集可能状態まで構築し、評価不能と明記して終了してください。正解データ・閾値の改変、結果の捏造、既存データ破壊、無断のコミット・pushは禁止です。

## 個別に実行

Python 3.10+（stdlibのみ）、Node.jsとmy-searchアプリのnpm依存が必要。

```bash
# キット自体の自動試験（合成・模擬サーバーのみ。未使用自然データの評価ではない）
python quality/e2e/tests/self_test.py
node quality/e2e/internal_refind/tools/self_test.mjs

# 公式の自然言語質問+正解アイテム+文書の取得・正規化（ネット必要）
python quality/e2e/tools/get_tomt.py --domain Books
# 必要なら: python quality/e2e/tools/get_tomt.py --domain Movies

# 実装の隔離DBとlocalhost APIを自動起動→全書籍文書をインポート→開発分割を測る
python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/books --stage development --out quality/e2e/artifacts/dev.json

# ベースライン/改善後の対応あり比較
python quality/e2e/tools/compare.py quality/e2e/artifacts/dev-before.json quality/e2e/artifacts/dev-after.json

# 改善が完全に終わった後一回だけ。持続的なベンチマーク評価。
python quality/e2e/tools/benchmark_api.py --repo . --data quality/e2e/data/reddit_tomt/books --stage holdout --final --out quality/e2e/artifacts/books-final/holdout.json

# 実利用n=500の事前検定計画
python quality/e2e/tools/sample_plan.py --n 500 --true-rate .98
```

## 同梱データと正確な範囲

| 収録物 | 状態 | 用途 |
|---|---|---|
| 以前のカード由来・合成348件 | JSONを同梱 | 退行確認、検索失敗パターンの診断のみ |
| Reddit-TOMT Books / Movies | **取得ツールと配布URLを同梱、原文データは未同梱** | 人間由来の質問→正解対象のベンチマーク |
| 書籍・映画の全候補文書 | 取得時に公式ZIPから正規化 | 文書欠落で簡単になるテストを防ぐ |
| 80/10/10固定ハッシュ分割 | 正規化時に生成 | development / validation / holdout |
| 実利用500セッション | **まだ0件** | 自然な再発見率の統計認定に必要 |
| `tools/live_study.py`（旧プロトコル） | 同梱・テスト済み | 複数人研究の事前登録、初回検索記録、後日の正解照合、封印、認定 |

Reddit-TOMT Booksの公式ZIPは2026-10-26に取得・検証済みで、実質問2,319件と書籍1,910件をGit除外のローカル領域に正規化した。データ取得、利用履歴、外部ベンチマークと個人データの役割は[データ出所](docs/DATA_SOURCES.md)と[評価範囲](docs/EXTERNAL-AND-PERSONAL-EVALUATION-SCOPES-ja.md)を参照する。raw質問やコーパスをGit管理・外部送信しない。

## 誤解しやすい点

- BM25のSciFact/MIRACLの良いスコアは、「保存済みカード一覧の `/api/cards`」の高品質を保証しない。実際のエンドポイントを隔離SQLiteに対して使う。
- Reddit-TOMTは正解対象が**書籍・映画**。自然に発せられた質問があることと、my-searchの実際の保存記事検索の統計的証拠になることは別。
- `Hit@10=95%` と、95%超を片側97.5%信頼で支持できることは異なる。初回n=500なら最低485/500成功が必要。
- my-searchの実利用の最終判定はFirst-query Hit@10と「180秒/3検索以内に正解カードを開けたか」の**両方**。同一ユーザー500回から全ユーザーの95%は結論できない。
- デフォルトの実利用向け研究プランはn=500の**500人から各初回1件**（収集可能になるまでは未達）。個人1人のテストは `--scope personal-longitudinal` で探究用にするが一般認定にはならない。
- 自然クエリの採取・同意・人間による正解確定はAIが代替できない。従って一回のCodex依頼は開発・収集機能の完成まで自律化できるが、その時点で実利用データがなければ認定だけは保留となる。

## ファイル一覧

- `CODEX_ONE_SHOT.md`：一度送るだけの全行程指示
- `tools/get_tomt.py`：公式ZIPのダウンロード、query/document/qrel正規化、グループ分割
- `tools/benchmark_api.py`：隔離DBで本物の`POST/GET /api/cards`を採点
- `tools/compare.py`：同一クエリでの改善・退行と対応あり比較
- `tools/stats.py`, `tools/sample_plan.py`：二項検定・Clopper-Pearson正確片側信頼下限・パワー
- `tools/live_study.py`：旧・複数人研究の登録、検索記録、後日正解判定、封印・最終評価
- `scripts/bench/init_personal_refind_capture.mjs` と `export_personal_refind_capture.mjs`：個人目標のローカル収集準備と適格記録の評価形式への変換
- `tools/fingerprint.py`：ローカル作業ツリーのコード指紋
- `internal_refind/`：既存348件の回帰テスト（統計認定には使わない）
- `docs/DATA_SOURCES.md`：出典、利用条件、範囲
- `docs/STUDY_PROTOCOL.md`：事前登録・サンプリング・UI収集実装・認定条件
- `tests/self_test.py`：模擬ZIPとモックAPIによる起動試験

収集した生クエリ、任意参加者の情報は`study/`に保存され、`.gitignore`で版管理から除外している。`git add -f`や別のバックアップ経路で公開しないこと。
