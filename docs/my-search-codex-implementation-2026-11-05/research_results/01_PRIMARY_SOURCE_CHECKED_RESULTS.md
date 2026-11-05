# 原典・実験結果のみをまとめた資料（2026-11-05）

## 本ファイルの性格

- 研究ごとの**対象、方法、比較条件、結果、限界、資料URL**だけを記す。my-searchに何を実装すべきかという助言・採用判断は記載しない。
- 出典と研究結果を忠実に要約したものであり、論文全文の転載ではない。
- このファイルの各記録は今回アクセスできた**一次資料の本文・要旨・研究機関の公式紹介**に照合したもの。全文を精読できていない記録には確認範囲を明記する。
- 残りの研究は `02_PAST_STUDIES_AS_RECORDED.md` に**以前の調査台帳の記録**として別掲載する。過去の全件を今回独立に検証したことを意味しない。

## R01｜When combinations of humans and AI are useful: A systematic review and meta-analysis
- **著者・年：** Vaccaro, Almaatouq & Malone（2024）
- **研究の種類：** 査読済みの事前登録・系統的レビュー/メタ分析
- **対象・方法・比較条件：** 2020年1月〜2023年6月の関連文献を探索。人間のみ、AIのみ、人間＋AIを評価した106実験／370効果量を統合。
- **報告された結果：** 人間＋AI vs 人間単独：g=+0.64、95%信頼区間[0.53, 0.74]。人間＋AI vs 両者のうち高性能な単独条件：g=-0.23、95%信頼区間[-0.39, -0.07]。意思決定タスクとコンテンツ制作タスクで異なる結果。
- **対象範囲・研究上の限界：** 研究間の強い異質性（相乗効果のI²=97.7%）、出版バイアスの可能性。平均値は個々の作業条件の普遍則ではない。
- **確認範囲：** 全文HTML・出版者の一次資料
- **原典：** https://www.nature.com/articles/s41562-024-02024-1

## R05｜Am I wasting my time organizing email? A study of email refinding
- **著者・年：** Whittaker, Matthews, Cerruti, Badenes & Tang（2011）
- **研究の種類：** CHI 2011・現場観察
- **対象・方法・比較条件：** 345人の長期ユーザーが行った85,000件超のメール再発見操作。検索、フォルダ、タグ、スレッドに対応したクライアントを計測。
- **報告された結果：** 複雑なフォルダ整理は再発見の成功率改善につながらず、準備にかかる労力に見合わなかった。検索・スレッドが再発見に役立つことを報告。
- **対象範囲・研究上の限界：** メールを対象とした観察研究。ファイルや技術記事の再発見、因果関係の全てについては直接測っていない。
- **確認範囲：** 研究者機関による発表と抄録
- **原典：** https://research.ibm.com/publications/am-i-wasting-my-time-organizing-email-a-study-of-email-refinding

## R13｜A comparison of static, adaptive, and adaptable menus
- **著者・年：** Findlater & McGrenere（2004）
- **研究の種類：** CHI 2004・統制実験
- **対象・方法・比較条件：** 27人、静的メニュー、利用者が調整できるメニュー、システムが適応させるメニューを比較。上位4項目の固定/手動/自動の条件。
- **報告された結果：** この条件では静的メニューが適応型より有意に速かった。手動調整型も特定条件で適応型より速かった。全体的な好みでは手動調整型が多数。
- **対象範囲・研究上の限界：** split menuを使った特定の操作課題の結果。あらゆる適応UIの結果ではない。
- **確認範囲：** ACMの論文抄録
- **原典：** https://doi.org/10.1145/985692.985704

## R18｜A Cost–Benefit Study of Text Entry Suggestion Interaction
- **著者・年：** Quinn & Zhai（2016）
- **研究の種類：** CHI 2016・文字入力実験
- **対象・方法・比較条件：** モバイル文字入力で、候補を常に表示／表示しない／確率閾値で表示の3条件を比較。
- **報告された結果：** 候補を積極的に表示するとキー操作数が減り主観的にも好まれたが、候補の注視・検討・利用コストにより平均入力時間は悪化。
- **対象範囲・研究上の限界：** モバイルの文字転記課題。AIによる文章読解や一般的な自動化の実験ではない。
- **確認範囲：** 著者所属機関の研究紹介・抄録
- **原典：** https://research.google/pubs/a-costbenefit-study-of-text-entry-suggestion-interaction/

## N04｜From Tabs to Structures: Understanding and Supporting Web Page Management
- **著者・年：** Rutishauser & Fritz（2026）
- **研究の種類：** CHI 2026・数週間のフィールド研究
- **対象・方法・比較条件：** 29人の知識労働者を対象に、ブラウザページの保存・事後的なグルーピング等を行うGstellを使用。
- **報告された結果：** 参加者は後から関連づけられるページを積極的に保存・閉じ、構造が明らかになるにつれグループを作った。著者らはフォーカスとページ管理を支援する初期的証拠と述べる。
- **対象範囲・研究上の限界：** 前後の実地研究で、独立した並行群による無作為化試験ではない。
- **確認範囲：** ACM掲載の論文本文・抄録の検索結果
- **原典：** https://doi.org/10.1145/3772318.3791979

## N05｜Shifting Work Patterns with Generative AI
- **著者・年：** Dillon, Jaffe, Immorlica & Stanton（2025）
- **研究の種類：** 6か月の企業横断・無作為化フィールド研究
- **対象・方法・比較条件：** 2025年4月のMicrosoft Research公開版は約6,000人（メール・文書・会議アプリに統合されたAIへのアクセス）。同研究のNBER改訂版は7,137人、66社と記載。
- **報告された結果：** Microsoft公開版：AI利用者はメール作業が週約3時間/25%短縮、ITT推定1.4時間。会議時間に有意差なし。NBER改訂版は約2時間短縮と記述し、推定・標本・分析版が違う。
- **対象範囲・研究上の限界：** 公開版と改訂版で記載の人数と推定値が異なる。別々の実験として二重計上しない。AIへのアクセス全体の効果であり、画面の一体化だけの効果を分離したものではない。
- **確認範囲：** Microsoft Research公式抄録、NBER公式改訂版 https://www.nber.org/papers/w33795
- **原典：** https://www.microsoft.com/en-us/research/publication/shifting-work-patterns-with-generative-ai/

## N07｜How explanations from XAI-based decision support affect human task performance: a meta-analysis
- **著者・年：** Haag（2026）
- **研究の種類：** 査読誌掲載メタ分析
- **対象・方法・比較条件：** AI予測＋説明の意思決定支援を、無支援条件およびAI予測のみの条件と比較。無支援比較4,589参加者、AI予測のみ比較7,706参加者のデータを含む。
- **報告された結果：** AI予測＋説明 vs 無支援：標準化平均差約0.52。AI予測＋説明 vs AI予測のみ：約0.09。説明の追加による平均的な改善幅は小さく、高バイアス研究ほど報告効果が大きい。
- **対象範囲・研究上の限界：** 研究の中心は分類タスク。説明手法ごとの差には一貫した大きな差が確認できない。
- **確認範囲：** 出版社の論文本文・抄録
- **原典：** https://doi.org/10.1080/12460125.2026.2616693

## N10｜TaCoS: Generated Context Summaries for Task Resumption
- **著者・年：** Lill, Hollenstein, Rutishauser, Meyer & Fritz（2026）
- **研究の種類：** ICSE 2026・統制ラボ実験
- **対象・方法・比較条件：** 32人のソフトウェア開発者が、手書きメモ／最近の編集履歴タイムライン／AI生成の文脈要約のいずれかを利用して3つのプログラミング作業を再開。
- **報告された結果：** 生成要約条件が再開までと最初の編集までの時間で最短、総合的な有用性評価でも高かった。一方、課題成功率は編集履歴タイムライン条件が最高。要約には将来の予定が欠けやすかった。
- **対象範囲・研究上の限界：** プログラミング課題に限定。早く再開することと最終的な正確さは別の指標。
- **確認範囲：** ICSE公式発表要旨
- **原典：** https://conf.researchr.org/details/icse-2026/icse-2026-research-track/184/TaCoS-Generated-Context-Summaries-for-Task-Resumption

## S01｜Sheridan & Wickens (2000), A model for types and levels of human interaction with automation
- **著者・年：** Parasuraman, Sheridan & Wickens (2000), A model for types and levels of human interaction with automation
- **研究の種類：** 概念モデル／レビュー
- **対象・方法・比較条件：** 情報の取得・分析・意思決定/選択・行動の実行という4段階と、各段階での自動化水準を区別する枠組み。
- **報告された結果：** 自動化により人間の作業がなくなるだけでなく、調整負担が生じる場合があると著者らは論じる。
- **対象範囲・研究上の限界：** 特定のUIの利用実験ではない。
- **確認範囲：** 研究者/出版社の一次資料抄録
- **原典：** https://pubmed.ncbi.nlm.nih.gov/11760769/

## S05｜Predictability and accuracy in adaptive user interfaces
- **著者・年：** Gajos et al. (2008), Predictability and accuracy in adaptive user interfaces
- **研究の種類：** 適応UIの利用実験
- **対象・方法・比較条件：** 適応アルゴリズムの「予測可能性」と「正確性」の条件を区別。
- **報告された結果：** 両方の向上で満足度が高まり、正確性の向上は性能と適応UIの利用率も改善した。
- **対象範囲・研究上の限界：** 特定の実験UIと課題の結果であり、他のUIに同じ効果が出るという結果ではない。
- **確認範囲：** 研究者/出版社の一次資料抄録
- **原典：** https://www.eecs.harvard.edu/~kgajos/papers/2008/gajos08predictability.shtml
