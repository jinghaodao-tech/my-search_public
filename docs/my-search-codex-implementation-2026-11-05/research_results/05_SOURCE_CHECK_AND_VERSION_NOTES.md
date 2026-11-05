# 原典照合と版の違い（検証監査）

調査日：2026年11月5日。

## 今回直接照合した一次情報（研究者・出版元・公的索引）

| ID | 主な照合先 | 内容確認の範囲 |
|---|---|---|
| S01 | https://pubmed.ncbi.nlm.nih.gov/11760769/ | 出版書誌・抄録 |
| R01 | https://www.nature.com/articles/s41562-024-02024-1 | 出版社の本文と要旨 |
| R05 | https://research.ibm.com/publications/am-i-wasting-my-time-organizing-email-a-study-of-email-refinding | 研究機関の公開要旨 |
| R13 | https://doi.org/10.1145/985692.985704 | 出版元の論文要旨 |
| S05 | https://www.eecs.harvard.edu/~kgajos/papers/2008/gajos08predictability.shtml | 著者による公開要旨 |
| R18 | https://research.google/pubs/a-costbenefit-study-of-text-entry-suggestion-interaction/ | 研究機関の公開要旨 |
| N04 | https://doi.org/10.1145/3772318.3791979 | ACMの掲載情報・公開本文検索結果 |
| N05 | https://www.microsoft.com/en-us/research/publication/shifting-work-patterns-with-generative-ai/ | 研究機関の公式要旨 |
| N05（改訂版） | https://www.nber.org/papers/w33795 | NBER公開の改訂版書誌・要旨 |
| N07 | https://doi.org/10.1080/12460125.2026.2616693 | 出版元の本文と要旨 |
| N10 | https://conf.researchr.org/details/icse-2026/icse-2026-research-track/184/TaCoS-Generated-Context-Summaries-for-Task-Resumption | 学会公式の要旨 |

「一次資料照合」は全文通読と同義ではありません。また、過去の台帳の研究48件の完全な再照合、引用・被引用研究の全件追跡、撤回情報の網羅的確認は**実施していません**。

## 同じ研究の版によって人数・推定値が異なる例

### Dillon et al., Shifting Work Patterns with Generative AI

- Microsoft Research、2025年4月公開の説明：6か月、約6,000人。AI利用者は週3時間・25%メール作業が減少、ITT推定1.4時間。会議時間は有意に変わらなかった。
- NBER Working Paper 33795、2025年11月改訂版の説明：66社・7,137人。処置群のうちツールを利用した80%について、実験後半のメール作業が週約2時間減少。全体タスク量・構成の変化は検出されなかったと報告。
- これらは**別研究ではなく同一研究の異なる版**として扱う。数値を片方に勝手に統一したり、2本の独立した検証と数えたりしない。

## 既存研究に関する観測値と適用範囲の区別

- 実験の参加者数・対象・比較条件は、論文が報告した範囲内でのみ記載。
- 提案文、設計上の判断、最良の実装方法、my-searchでの性能予測は本資料では記載しない。
- 同一著者・同一標本の研究は、複数の独立した再現とは扱わない。
- 原典にない効果量、検定結果、サンプル数は推測して追加しない。
- 「記載なし」は「測定していない」という意味ではない。今回参照した原典・台帳に記載がないことだけを意味する。
