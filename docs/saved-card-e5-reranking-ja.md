# 保存カード検索のE5実験モード

既定の保存カード検索は従来どおりBM25です。E5は任意の実験モードで、BM25候補を検索した後、`multilingual-e5-small`の意味順位とBM25順位を等重みRRF（`k=60`）で融合します。E5は候補生成を置き換えず、BM25上位候補に存在しないカードは回復できません。

## 有効化

まず一度だけ、明示的にモデルを取得します。

```powershell
npm.cmd run prepare:e5-model
```

モデルは既定で`data/models/`に保存されます。アプリは通常起動時にネットワークからモデルを取得しません。別の場所を使う場合は`E5_MODEL_CACHE_DIR`を設定してください。

次に`.env`へ設定してアプリを再起動します。

```dotenv
CARD_SEARCH_ENGINE=e5-rrf
CARD_SEARCH_E5_CANDIDATES=100
E5_MODEL_CACHE_DIR=data/models
```

候補数は20〜500件です。モデル未導入や推論失敗時は、その検索リクエストをBM25で再実行し、応答の`scope.fallbackUsed`でフォールバックを示します。設定を`CARD_SEARCH_ENGINE=like`へ戻すと従来のBM25検索になります。

## 動作と制約

- E5はCPUで動作し、API起動時にはロードされません。E5検索を初めて実行したときにモデルをロードします。
- クエリは設定済みキーワードと類義語を使用します。本文表現は`title`、`summary`、`tags`、`body`の順でモデルへ渡します。
- 文書ベクトルはプロセス内LRUキャッシュ（最大5,000件）に保存されます。カードの内容が変われば入力テキストのハッシュも変わり、別ベクトルとして計算されます。プロセス再起動後は必要に応じて再計算します。
- BM25のアーカイブ閾値による対象区分は維持します。E5/RRFスコアは順位表示用に候補内で正規化され、BM25の生スコアは`scoreSources`に残ります。
- E5は検索ごとにCPU時間とRAMを追加消費します。モデルなしの通常検索は既定のままです。

## 検証

合成ベクトルによるRRFの順位・同点安定性は`tests/e5_rrf_ranker.test.ts`で確認します。モデルがある環境で実API経路を追加確認する場合:

```powershell
$env:RUN_E5_MODEL_INTEGRATION = '1'
$env:E5_MODEL_CACHE_DIR = 'quality/e2e/local/embedding-cache'
npx.cmd vitest run tests/cards.test.ts -t 'prepared local E5 model'
```

このモードを既定にする判断は、実際の保存カード・自然な検索クエリを使った事前登録評価と、利用者端末でのレイテンシ/RAM測定後に行います。公開ベンチマークの改善だけでは実利用の改善を意味しません。
