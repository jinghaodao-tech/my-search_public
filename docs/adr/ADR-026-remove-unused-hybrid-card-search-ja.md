# ADR-026: 使われていないカード用ハイブリッド検索実装の削除

## 背景
`search/hybrid_card_search.ts`は`runHybridCardSearch`をエクスポートしていて、
BM25エンジンとSQLite FTS5(`cards_fts`)を組み合わせてカードをランキングする、
完全に動く実装になっている。しかしコードベース全体(routes・services・
scripts・tests)のどこからも呼び出されていない。単一コミット
(「Complete search workflow and verification gates」、2026-07-31)で
追加されて以来、一度も触られていない。

同じ「BM25とFTS5を混ぜる」というアイデアは、既に別の2つの経路で生きている:
`search_engine.ts`の`HybridSearchEngine`(`SEARCH_ENGINE=hybrid`で選択、
`services/route_context.ts`で配線済み)と、`cards_repository.ts`の
`CARD_SEARCH_ENGINE=fts5`経路——どちらもconfigで切り替え可能で、テストも
ある。`hybrid_card_search.ts`は、この2つが既に提供している機能を重複させて
いるだけ。

## 決定
`search/hybrid_card_search.ts`を削除する。ハイブリッドランキング機能は、
実際に生きていてテストもある`HybridSearchEngine`と
`CARD_SEARCH_ENGINE=fts5`経路の側に残す。

## 代替案
- 参考コードとして残す: 却下。テストカバレッジがなく、どこからもimportされて
  おらず、`bm25_engine.ts`や`cards_fts`スキーマが今後変わるたびに、気づかれ
  ないままずれていく。
- 第三の検索オプションとして配線する: 却下。`HybridSearchEngine`や
  `CARD_SEARCH_ENGINE=fts5`でまだカバーされていないユースケースが存在しない。

## 影響
挙動は変わらない——現状どこからも呼ばれていないコードなので。BM25+FTS5の
ブレンドロジックの重複実装がなくなり、記事用のハイブリッド経路
(`HybridSearchEngine`)とカード一覧フィルタ用の経路
(`CARD_SEARCH_ENGINE=fts5`)がそれぞれ1つずつになる(到達不能な第三の
バリエーションがなくなる)。

## コード上の根拠
`search/hybrid_card_search.ts`(削除対象)、`search/search_engine.ts`
(`HybridSearchEngine`)、`repositories/cards_repository.ts`
(`CARD_SEARCH_ENGINE`の分岐)、`services/route_context.ts`
(`createSearchEngine()`の呼び出し箇所)。

## 撤回条件
`HybridSearchEngine`にも`CARD_SEARCH_ENGINE=fts5`にも対応できない
ユースケースが実際に出てきた場合のみ再検討する。

## ステータス

実装済み: 呼び出し元がないことを確認し、search/hybrid_card_search.tsを削除した。既存の2つのハイブリッド検索経路は維持する。
