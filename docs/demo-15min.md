# 15分デモ手順

## 0:00-1:30 問題と中心フロー

説明: 外部情報を集めても、選別・保存・整理・再発見が分断される問題を解決する。画面上部の工程表示を確認する。

## 1:30-3:00 収集

1. 
pm run demo` starts the seed-and-server flow, or run 
pm run seed:demo` and 
pm start` separately.
2. 
pm start`
3. 収集画面でfixtureまたはローカル保存済み候補を確認する。

## 3:00-5:00 BM25選別

BM25画面で収集記事をデータソースにし、キーワードを設定する。スコア、同義語、候補の順位を確認する。

## 5:00-8:00 Reviewと保存

候補レビュー画面で一件をレビュー済みにし、別の一件を見送る。保存する候補はカードへ保存し、`saved_as_card`を確認する。

## 8:00-11:00 整理

カードへタグを追加し、KJグループへ割り当てる。別カードへの一方向Zettelkastenリンクを作成し、対象カードのbacklinkを確認する。

## 11:00-13:00 再発見

カード画面の「保存済みカードを検索」で保存済み知識を検索する。BM25が収集候補、通常検索が保存済みカードを担当することを説明する。

## 13:00-14:00 Export

カード詳細からMarkdown exportを実行する。

## 14:00-15:00 設計判断

SQLite、事前計算tokens、候補保持期限、Foreign Key、Migration、AI非依存、local-first境界を説明する。

自動確認は 
pm run verify`、実HTTP性能確認は 
pm run benchmark:http` で再現できる。