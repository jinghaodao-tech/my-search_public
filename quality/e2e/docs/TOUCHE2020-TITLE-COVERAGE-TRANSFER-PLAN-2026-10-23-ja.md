# Webis-Touche2020への固定タイトルcoverage転移計画

## 目的

標準BM25上位1,000件を候補集合とし、候補内min-max正規化スコアへタイトルkeyword coverageを加える固定方式が、議論検索ドメインでも標準BM25を上回るか診断する。タイトルcoverage重みは既存の転移実験で固定済みの`0.1`とし、Toucheの結果を見て変更しない。

## データと由来

- データセット: BEIR `webis-touche2020`、公式test split
- 配布元: [BEIR公式データセット一覧](https://github.com/beir-cellar/beir/wiki/Datasets-available) / [公式配布ZIP](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/webis-touche2020.zip)
- データカード記載ライセンス: CC BY-SA 4.0 ([データカード](https://huggingface.co/datasets/BeIR/webis-touche2020))
- 期待規模: 382,545文書、49クエリ
- 配布MD5: `46f650ba5a527fc69e0a6521c5a23563`
- ローカルZIP実測MD5: `46f650ba5a527fc69e0a6521c5a23563`
- BEIR公式配布のtest qrelsのみを使用する。開発目的のパラメーター調整には転用しない。

## 固定比較

1. 対照: Unicode単語分割、BM25 `k1=1.2, b=0.75`。
2. 候補: 対照ランキングの上位1,000件だけを対象に、候補内min-max正規化BM25スコアへ`0.1 × title keyword coverage`を加えて再順位付け。
3. 同じコーパス、クエリ解析、tokenizer、qrels、評価指標を両方式で共有する。
4. corpus外の正例は正解分母から黙って除外しない。入力ファイルのSHA-256、欠落正例数、クエリ別順位を成果物に保存する。
5. 主指標はnDCG@10。補助指標はHit@1/10、MRR@10、Recall@100、MAP@100。速度はranking-only p50/p95で、構築・解析時間と区別する。
6. 関連文書共有に基づくquery cluster bootstrapを実施し、十分な独立clusterがなければ`NOT_EVALUABLE`とする。

## 解釈上の制限

Toucheの49クエリは議論検索であり、保存済み日本語技術記事の自然な再発見を代表しない。タイトル補正の候補固有転移診断であって、横断的な安定優位の確認試験ではない。結果の後付け調整、正解ラベル変更、本番ランキングへの適用は行わない。

## 実行コマンド

```powershell
npx.cmd tsx scripts/bench/benchmark_title_coverage_transfer.ts .tmp-ir-transfer/webis-touche2020 quality/e2e/artifacts/webis-touche2020-title-coverage-w01-20261023.json test 0.1
```
