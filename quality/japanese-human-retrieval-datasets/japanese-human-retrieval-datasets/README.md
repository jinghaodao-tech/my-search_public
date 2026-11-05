# 日本語・人手由来の検索評価データ取得キット

作成日：2026-10-21。ZIPには取得・正規化ツールと評価指示を含む。実データはリポジトリのGit管理対象外の `local_article_corpus/japanese-human-retrieval/` に取得済み。内容と件数は各データセットのmanifestを正本とする。

## 取得先と選定根拠

| 名称 | 取得状況 | 内容 | 主な制約 |
| --- | --- | --- | --- |
| **JNQ / Japanese Natural Questions** | **本体の公開配布先を確認できず、未取得** | 2025年J-STAGE掲載版は検索ログ由来16,641質問、2024年会議論文は16,871質問と記載。人手による質問選別・回答アノテーション | 論文間で件数が異なり、アクセス可能な一次配布先とデータ版を特定できないため評価に含めない |
| **JaGovFaqsRetrieval** | **取得・検証済み** | 22,794文書、2,048質問、2,048の既存FAQ対応ラベル。開発614、検証410、ホールドアウト1,024（各クエリは固有正解文書） | 公的機関作成のFAQ質問・回答ペアで、検索ログではない。CC BY 4.0 |
| **MIRACL-日本語** | **公式評価データと全文書コーパスを取得・検証済み** | 6,953,614 Wikipedia文書。消費済み評価IDを除外後、開発2,586問/2,323クラスタ、検証639問/581クラスタ、ホールドアウト752問/726クラスタ | 人手作成質問と関連性判断によるWikipedia検索評価。JaGovFaqsや実利用検索と無条件に合算しない |

- JNQ 2025年J-STAGE掲載版: https://www.jstage.jst.go.jp/article/jnlp/32/2/32_497/_article/-char/ja/
- JNQ 2024年会議論文: https://aclanthology.org/2024.starsem-1.5/
- JaGovFaqs: https://huggingface.co/datasets/mteb/JaGovFaqsRetrieval
- MIRACL: https://huggingface.co/datasets/miracl/miracl
- MIRACL本文: https://huggingface.co/datasets/miracl/miracl-corpus
- JaGovFaqsライセンス: CC BY 4.0。使用時には元配布元と原著者の表示が必要

## Windows PowerShellで実データを取得する

以下は取得を再現する場合の手順。現在の取得物は前記の作業ディレクトリに存在し、JaGovFaqsのmanifestは `local_article_corpus/japanese-human-retrieval/jagov/manifest.json`、MIRACL評価manifestは `local_article_corpus/japanese-human-retrieval/miracl-eval/manifest.json`、MIRACL文書manifestは `local_article_corpus/japanese-human-retrieval/miracl-corpus/corpus_manifest.json`。

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest test_prepare -v

# 推奨：日本語・人間が記述した質問と回答文書、正解ペアを取得
.\.venv\Scripts\python.exe fetch_prepare.py --dataset jagov --out downloads/jagov

# 補助：MIRACL日本語の公式質問と正解ラベルを取得
.\.venv\Scripts\python.exe fetch_prepare.py --dataset miracl-ja --out downloads/miracl-ja
```

取得パッケージの `miracl-ja` コマンド単体が取得するのは質問と正解ラベルだけ。今回の全文書コーパスは別の公式コーパス取得スクリプトで取得し、SHA-256と6,953,614件の行数を検証した。全文書を索引化したmy-search実API評価は別工程であり、取得済みというだけで評価済みとはしない。

取得が成功すると各出力ディレクトリに次を保存する。

- `corpus.jsonl`: `{"id": ..., "title": ..., "text": ...}` （JaGovFaqsのみ）
- `queries.jsonl`: `{"id": ..., "query": ...}`
- `qrels.tsv`: `query_id 0 document_id 1` のTREC形式（不適合ラベルは0）
- `splits.jsonl`: グループを共通正解文書でまとめ、ハッシュ固定でdevelopment / validation / holdoutに分割
- `manifest.json`: 件数、分割数、取得元コミット、4ファイルのSHA-256

**書き込み先は指定した `downloads/` のみ。my-searchのDB・カード・メモには触れない。**

## 評価と統計

JaGovFaqs全件について、正解文書が必ず候補集合にある状態で検索する。開発614問・検証410問に加え、holdout 1,024問も `artifacts/jagov-e5-rrf-holdout-1024-20261024-preregistered.json` の探索で評価済みである。このholdoutは独立した最終認定に再利用しない。下記の統計ゲートは過去結果の再現と形式検査に限り、新しい認定には未使用の外部セットを用意する。

```powershell
.\.venv\Scripts\python.exe stats_gate.py --dataset-dir downloads/jagov --results results/holdout.jsonl
```

- `stats_gate.py` は欠落・重複・非holdoutの結果を拒否する。
- 同一正解記事への質問が複数ある場合、単純二項検定は`NOT_EVALUABLE`とし、クラスタ依存を考慮する評価計画が別途必要。
- 公開ベンチマークのHit@10は、実際に保存済みZenn記事を見つけられる確率そのものではない。
- MIRACLは未使用データの扱いを、既存のmy-search評価履歴と照合してから決めること。

## 技術的制約

データ取得・正規化とコーパスのSHA-256検査は実行済み。取得したことと、検索評価に使用したことは区別する。MIRACL全文書6,953,614件は評価専用の隔離SQLite `local_article_corpus/japanese-human-retrieval/miracl-full-fts.sqlite` に投入済みで、形態素FTS5による全件検索と探索用のAPI比較を実施した。未使用ホールドアウトの最終評価は別途、事前登録とコード固定後に一度だけ行う。これは保存記事の実利用再発見性能を直接測るものではない。

`sample_fixture/` は **完全な合成データ**で、取得済みの実評価データではない。これはフォーマットと処理の動作確認専用。
