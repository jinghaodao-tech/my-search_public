# 作成時に実施した検証

- `python tests/self_test.py` （75架空文書・150架空質問を格納した模擬ZIP＋模擬サーバー＋実利用記録の模擬入力）: 4 tests OK。
- `node internal_refind/tools/self_test.mjs` （ローカルモックAPI）: PASS。
- `python tools/sample_plan.py --n 500 --true-rate 0.98`: 片側α=0.025、485件以上、検出力約0.953。
- `python -m py_compile tools/*.py`: ソース構文チェック済み。

**未確認:** upstream Books/Moviesの本物ZIP取得と展開（この環境では外部ダウンロードがDNS失敗）、実my-searchを使った隔離DBでのエンドツーエンド評価、アプリに実利用ログ導線を設置する改修、実参加者によるセッション、両95%の統計認定。これらを「実施済み」と報告しない。

**注意:** テストの一部は意図的に作ったダミークエリとモックレスポンス。実データと混同しない。
