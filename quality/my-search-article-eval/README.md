# my-search 技術記事・統計評価セット

## 目的

技術記事を**約2,500件（最小2,000件）**収集し、400件の開発・400件の検証・1,200件の最終評価ターゲットに分ける。これは**文書集合の準備**であり、独立した検索クエリ1,200件が付かない限り、検索成功率95%の統計的裏付けにはならない。

## 使い方

Python 3.10+ （標準ライブラリのみ。環境変数 `QIITA_TOKEN` は任意）

```powershell
python scripts/collect_articles.py --output local_article_corpus --target 2500 --minimum 2000
python scripts/design_and_judge.py plan --corpus local_article_corpus/articles_unique_titles.jsonl --output local_article_corpus/plan
python scripts/make_dev_queries.py --corpus local_article_corpus/articles_unique_titles.jsonl --plan local_article_corpus/plan
python scripts/to_cards.py --corpus local_article_corpus/articles_unique_titles.jsonl
python scripts/design_and_judge.py sample-sizes
python -m unittest tests -v
```

- Zennは公式RSS。Qiitaは公式APIのみ。規約に反してWebページをスクレイピングしない。
- Qiita APIは無認証で60回/時、認証あり1000回/時（公式資料）。既定は最大48リクエスト＋Zenn公式RSS。制限超過・不達なら再実行時に取得結果を補える。毎回発行済みレートリミットに従う。
- 収集するのは、タイトル・URL・タグ・著者・日時と短い説明。Qiitaの**本文**をローカル限定で扱う場合は許諾と規約を確認し、明示的に `--include-qiita-body` を付ける。無条件の全文利用は保証しない。
- 収集元例: https://zenn.dev/feed / https://zenn.dev/topics/typescript/feed / https://qiita.com/api/v2/items?query=tag:TypeScript
- 得られた `local_article_corpus/` は第三者の情報を含むため共有・Gitコミットしない。
- Zennのトピックフィードだけで2,500件に満たない可能性はあり、Qiita公式APIと併用する。不足時には不足で終了する。

## 出力

| ファイル | 用途 |
|---|---|
| `articles.jsonl` | 公開元に対応する技術記事メタデータ。全文含有はレコード単位で明示 |
| `articles_unique_titles.jsonl` | 正規化した完全一致タイトルを保守的に1件へまとめた評価用派生コーパス |
| `manifest.json` | 件数、重複排除後件数、ソース内訳、SHA256、取得エラー |
| `exact_title_review_candidates.json` / `similarity_review_candidates.json` | タイトル重複・文字3-gram類似候補。類似候補は自動削除しない |
| `plan/*_annotation_blank.csv` | 固定記事IDと未入力の検索文・正解判断欄 |
| `plan/*_synthetic_queries.jsonl` | タイトル・タグから逆生成した開発テスト。**統計認定に使用禁止** |
| `cards_fixture.jsonl` | my-searchの隔離DBインポート向け文書レコード。本文なければ説明文だけ |

## 統計判定の数値

「独立し、事前に定義した母集団を代表する1,200検索試行」という仮定の下、H0:成功率 <=95%、片側α=2.5%、Clopper–Pearson片側下限 >95% を合格とする。1,200回では **1,155回以上の成功**が必要。この計画は真の成功率97%で検出力約94.2%。

記事2,500件という件数自体にはこの検定力の意味はない。検定力を規定するのは主として検索試行数、独立性、効果量、帰無閾値。特にクエリが本文・タイトルから自動生成された場合は、実際のうろ覚え再発見を代表しない。同一著者・同一対象に依存があれば個別のクラスタ解析が必要。

## 現在の実行結果

実行レポートは [RESULTS_2026-10-21-ja.md](RESULTS_2026-10-21-ja.md) を参照。ローカルの `local_article_corpus/` に記事メタデータを保存し、Git追跡対象外としている。自然検索クエリと独立した正解ラベルは未収集のため、最終統計判定は `NOT_EVALUABLE`。

## 参考

- Zenn公式RSS: https://zenn.dev/zenn/articles/zenn-feed-rss
- Zenn著作権: https://zenn.dev/terms
- Qiita API仕様・リミット: https://qiita.com/api/v2/docs
- Qiita公式のスクレイピング不可の説明: https://help.qiita.com/ja/articles/qiita-api
- Qiita著作権: https://qiita.com/terms
