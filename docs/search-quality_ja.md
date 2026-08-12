# 検索品質評価

レイテンシのベンチマークとは別に、決定的な検索品質評価を実行できます。

## データセット

合成評価は57文書・20ケース（dataset version: v5-57-docs-20-query-cases）です。realのリリースシグナルは233文書の匿名化コーパスと、手書き50ケース（dataset version: anonymized-card-corpus-v2-50-manual-queries）で構成します。realケースには話題、難易度、言語、正解文書数（単数・複数）のラベルを持たせています。

## 指標

- Precision@1 / R-Precision（期待文書数Rに対する上位R件の精度）
- MRR
- Recall@5
- nDCG@5

同義語展開なし、時間減衰なしのBM25バリアントも比較します。

## 実行

```bash
npm run evaluate:search
```

評価結果にはデータセット規模、ケース別指標、集計値、バリアント比較が出力されます。

## 制限

一般Web検索のベンチマークではなく、検索ロジックの回帰検出を目的とした決定的な評価fixtureです。FTS5はローカルの`HybridSearchEngine`で利用でき、ベクトル検索は比較候補として記録しています。
