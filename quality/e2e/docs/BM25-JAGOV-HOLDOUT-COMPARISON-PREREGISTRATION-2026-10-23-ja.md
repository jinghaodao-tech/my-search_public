# JAGOV公式holdout BM25比較の事前登録

## 状態

評価前に固定。結果確認後の設定変更・同じholdoutでの再選択は行わない。

## 問いと主判定

現行の独自BM25検索経路A0は、標準形態素BM25（k1=1.2,b=0.75）より、JAGOV公式holdoutにおけるnDCG@10が高いか。

- 主評価量: `nDCG@10(A0) - nDCG@10(S3)`。
- 優位の基準: 対応あり正解文書クラスタbootstrapの95% percentile CI下限が0を超える。
- 指標・qrels・閾値は変更しない。未達なら「優位を確認できず」と報告する。
- Recall@100、MRR@10、MAP@100、rank-only p50/p95は副次的記述指標とし、方式採択の多重な主検定には使わない。

## データ固定

- 出典: JaGovFaqs / JAGOV official dataset、CC-BY-4.0。
- 分割: 公式 `holdout` の全1,024 query。subset抽出をしない。
- 全文書: `documents.jsonl` の全22,794件。
- qrels: holdout各行の `gold_ids` をそのまま二値関連として使用。クエリ、正解、文書の修正・検索結果を見た後の除外は禁止。
- holdout source SHA-256: `82663ea03b85ef82cd757380f9e0766934d657c8dc712f63c2a8e5cf7dffb2e7`。
- corpus SHA-256: `5222477847a65862184808d4ef338c4845c0baeef886d3346b5c968f56e9c10e`。
- 元DB・本番DBは書込み禁止。既存JAGOV隔離DBをSQLite backupで新規のholdout専用DBへ複製する。
- 開発・validation分割と同じ正規化済み形態素/N-gramトークン、クエリ解析、BM25評価実装を使う。

このJAGOVソースのdevelopment/validationは先行調査に使用済みだが、今回の前にholdout行を評価した記録は見つからなかった。したがって本結果は**同一データセット内の未使用公式分割への固定転移評価**であり、独立データソースや実利用者セッションによる証明ではない。

## 固定方式

| ID | 事前固定設定 | 用途 |
|---|---|---|
| A0-current-custom | k1=1.2,b=0.3、形態素＋N-gram max正規化等重み、希少語/クエリ語重み/共起/網羅率/時間減衰ON、候補和集合 | 主候補（現行独自方式の構成を維持） |
| S3-standard-morph-k1.2-b0.75 | 形態素のみ、k1=1.2,b=0.75、追加補正なし | 主比較の標準BM25 |
| S1-standard-morph-same-kb | 形態素のみ、k1=1.2,b=0.3、追加補正なし | b差を分ける副次診断 |
| S4-standard-dual-maxnorm-same-kb | 標準BM25を形態素/N-gram双方で計算し、max正規化後に等重み合成、k1=1.2,b=0.3、補正なし | 2信号合成の副次診断 |

副次診断の勝敗で主判定を置き換えない。A0の全記事日はimport時固定なので時間減衰係数は記事間順位に作用しないことを事前に記録する。

## 固定コード

- benchmark implementation SHA-256: `a53f3ffa999b62799758b76fc2e975128a76d9c37f139360681541df50bfab00` (`scripts/bench/evaluate_bm25_ablation.ts`)
- paired analysis SHA-256: `4767f51115c85d27de2544eeff1e7ffd8c088a520b411d924258aa230939fea8` (`scripts/bench/compare_bm25_ablation_variants.ts`)
- cluster単位: qrel正解文書IDが共有されるqueryを連結したconnected component。層化せず、クラスタを復元抽出する。
- bootstrap反復数: 20,000。区間: 両側 percentile 95%。
- seed: dataset/variant/metric文字列のSHA-256先頭32bit。コードが決定する。
- 同一実行で全方式を計算し、評価後のチューニングをしない。

## 解釈制限

JAGOV FAQは公開された質問と回答文書の適合関係であり、保存記事を後日探すmy-search利用者のクエリではない。nDCGの差が主基準を満たしても、技術記事や実利用検索に対する一般優位を意味しない。複数の既存評価を経た後の別公式分割なので、過去の探索自由度までは補正しない。
