# W6 API設計レビュー：リポジトリ別メモ

このメモは、my-search-app_publicのADR-023と、別リポジトリで作成すべきADRの境界を記録する。3リポジトリを単一の契約へ強制的に統合しない。

## MeTheory

`apps/api/src/server.ts` の `json(response, statusCode, body)` を中心とした契約を維持する。200/201/400/401/403/404/409/500/502/503の使い分けは既に比較的規律があるため、my-searchのルールをそのまま移植しない。今後の別ADRでは、巨大な単一ルーターの分割、エラー形式の固定、上流障害（502/503）の境界、競合処理のテストを扱う。

## Personal-Context-Studio（PCS）

`DELETE /v1/context-entries/:id` は物理削除ではなく論理アーカイブであり、append-only revisionsとprovenanceの設計思想に合わせる必要がある。したがってmy-searchの物理DELETE向け404方針をそのまま適用しない。PCS固有の別ADRでは、存在しないIDを200で扱うか404にするか、アーカイブ済みIDの再処理、監査証跡、冪等なアーカイブ操作を明示する。

## 作成順

1. my-search-app_public：ADR-023を基準にルートとテストを更新する。
2. MeTheory：既存の502/503を含む契約を保った別ADRを作成する。
3. PCS：論理削除とprovenanceを前提にした別ADRを作成する。

MeTheoryとPCSの実ファイルは各リポジトリの作業ツリーで作成する。ここでは契約を混同しないための境界だけを記録する。
