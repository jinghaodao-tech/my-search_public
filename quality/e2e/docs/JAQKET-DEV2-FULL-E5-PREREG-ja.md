# JAQKET dev2 全件E5確認の事前固定

2026-10-26に公開dev1で全件E5を探索した後、同じ方式設定を別splitで確認するための事前固定記録。dev2のスコアを見る前に作成した。公開クイズQAであり、保存記事の一般的な再発見や本人の最終評価を認定するものではない。

## 固定条件

- 質問: `quality/e2e/local/jaqket-public/dev2_questions.json`。質問・正解・本文はローカル隔離領域のみ。
- 対象: JQaRA既使用正解記事とdev1正解記事を除外したdev2の適格質問から、正解記事を連結成分でまとめた100グループ。サンプルはデータファイルのSHA-256をseedに決定する。選んだ質問IDのハッシュを実行結果に記録する。
- コーパス: SHA-256 `4f43754d40d0b3dd691c4eecf198e1ce6fbb0d32a9f309a402e806ab1064f304` の隔離SQLite 114,228文書。
- クエリ: 現行の自然文解析語＋元検索文の形態素語 (`parsed-plus-raw`)。
- FTS候補深度: 100。
- 全件E5: `Xenova/multilingual-e5-small` q8、384次元、mean pooling、正規化、質問prefix `query:`、文書prefix `passage:`。文書入力はタイトル＋本文冒頭512文字。全114,228文書とのexact cosine similarityからTop100を取る。
- 融合: FTS Top100とE5 Top100の等重みRRF、k=60、出力深度100。
- 主指標: Hit@10。併記: FTS/E5/融合の候補coverage、候補 miss、候補取得後のTop10 miss、API/索引エラー、正解記事グループbootstrap 95%区間、p50/p95。
- モデル・索引・質問・設定準備時間は検索時間と分ける。ローカルベクトルキャッシュはコーパス、記事ID順、モデル、実行環境、埋め込み条件の指紋を一致検査してのみ再利用する。

## 結果を見る前の扱い

この一回でdev1固定設定のsplit転移を測る。dev2の結果を見て検索語、モデル、RRF重み、候補深度、文書入力を変えない。結果確認後に方式を調整した場合、dev2は開発用へ格下げし、最終評価・独立holdoutと呼ばない。失敗・未完了質問を結果後に除外しない。

実行コマンド:

```powershell
npx tsx scripts/bench/benchmark_jaqket_retrieval.ts dev2 quality/e2e/local/jaqket-public quality/e2e/local/jaqket-public/corpus.sqlite quality/e2e/local/jaqket-public/result-dev2-full-e5-100groups-title512-20261026-v1.json 100 full-corpus-e5 100 parsed-plus-raw
```

結果はGit除外領域の同ディレクトリへ保存する。質問文・記事本文は出力しない。全件E5の実装・準備・運用負担を含めた記録を残す。

## 実施結果

2026-10-26に固定条件を実行。dev2 100記事グループ・102問でFTS5 80/102 (78.43%)、全件E5単独73/102 (71.57%)、FTS5＋E5 RRF 85/102 (83.33%)。融合の対象グループbootstrap 95%区間は76.00–90.29%、Hit@10 95%には届かなかった。API・索引エラー0件。質問ID SHA-256は `b073023f7540091b4199fab182d1180c7596fa659ec21d2111eb6322520507d5`。全件ベクトル準備は約117.3分、隔離ベクトルキャッシュは175,454,208 bytes。全体の集計、失敗内訳、制約は[追試報告](JAQKET-DEV2-FULL-E5-100GROUPS-20261026-ja.md)を参照。
