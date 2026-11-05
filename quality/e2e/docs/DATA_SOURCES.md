# 公開データの出所と注意事項

## Reddit-TOMT（本パッケージが実際に取得・正規化するデータ）

- 研究: Bhargav, Sidiropoulos, Kanoulas (WSDM 2022), *It's on the tip of my tongue: A new dataset for known-item retrieval*.
- 公式リポジトリ: https://github.com/samarthbhargav/tomt-data
- 公式形式: https://github.com/samarthbhargav/tomt-data/blob/main/DATA.md
- Books 配布 ZIP: https://raw.githubusercontent.com/samarthbhargav/tomt-data/main/data_release/Books.zip
- Movies 配布 ZIP: https://raw.githubusercontent.com/samarthbhargav/tomt-data/main/data_release/Movies.zip
- リポジトリのソースライセンスはMIT。ただし、投稿者の文章・作品説明の権利が全てMITで再配布可能と断定しないこと。ローカル研究用の取得を基本とし、研究・公開利用の条件は確認する。

質問はRedditの実際の投稿に由来するが、当該製品の検索入力ログではない。文書集合は書籍/映画の説明で、保存したニュース記事の再発見とは異なる。`queries.json`の`meta.replies`には回答が混じるため、検索語に混ぜない。本キットの分割は正解アイテムID単位の固定ハッシュ80/10/10（オリジナル論文の公式分割とは別）で、同一アイテムに属する言い換えが改善・最終評価に分散しにくいようにしている。

## 参考にできる他のデータ（本パッケージには未収録）

- Webis-KIQC-13: https://zenodo.org/records/3254421
  - Yahoo! Answers由来のknown-item質問2,755件に人手注釈とClueWeb09の正解文書IDを付与。課題はWebページ再発見に近いが、対象は英語・2009年のWebコーパスで、ClueWeb09はライセンス手続きと大規模取得が必要。
- TREC-ToT 2025: https://trec-tot.github.io/guidelines.html
  - 名前の思い出せない対象を自然言語で探す。ただし完全なコーパスは圧縮約9.1GB。テストには人間作成・生成データ等が混在。
- ORCAS: https://microsoft.github.io/msmarco/ORCAS
  - Bing検索のクエリ→クリック対象の組。一般Web検索のクリックであり、「以前保存した記事」の正解ログではない。非商用研究用途に制限がある。
- TREC Session 2014: https://pages.nist.gov/trec-browser/trec23/overview/
  - 実際の検索セッション・クリック等。保存記事の再発見とは同一ではない。

**重要:** 未使用データを使った統計結果は、その元のデータ収集方式・コーパス・言語・時代・利用者集団に対する条件付きの評価。my-searchの利用者全体へ無条件に外挿しない。

2026-10-26に Books 配布ZIPの取得・検証に成功した。元ZIPのSHA-256は `7c4585a9ca18bd26c4040c478d7099c9942ad6bf59462ff602d24d101e4daf03`、正規化結果は書籍1,910件・人手由来質問2,319件（全件適格）、固定分割はdevelopment 1,842 / validation 234 / holdout 243。データ本体と検索文は `quality/e2e/.gitignore` 対象のローカル隔離領域に置き、Gitには追加しない。Books holdoutは過去の評価で消費済みなので再利用しない。Moviesは未取得。取得・正規化・既存分割の使用履歴は [外部ベンチマーク評価範囲](EXTERNAL-AND-PERSONAL-EVALUATION-SCOPES-ja.md) を参照する。

## 配布について

生成したZIPには公開自然検索データそのものを含めない。公式 Books ZIP は作業環境で取得・現物検証し、正規化した実データはGit除外のローカル領域に保管する。配布物・Gitにはコーパスや質問本文を含めず、必要な利用者が公式配布元から取得する。取得失敗・形式変更があった場合、適当な偽データを生成して代替してはならない。
