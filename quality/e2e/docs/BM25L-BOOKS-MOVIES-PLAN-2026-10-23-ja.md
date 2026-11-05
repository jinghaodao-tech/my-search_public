# BM25Lの比較計画（Books / Movies）

## 仮説

標準BM25の長文書における長さ正規化が、該当語のある長文書を過度に減点しうるという既報の仮説を調べる。BM25Lは正規化TFを `c'=tf/(1-b+b*dl/avgdl)` とし、`tf>0` のとき `(k1+1)(c'+delta)/(k1+c'+delta)` を使う。ここでは原論文で使われた `delta=0.5` を固定し、係数探索はしない。

出典: [Lv and Zhai, “When Documents Are Very Long, BM25 Fails!”, SIGIR 2011](https://lintool.github.io/robust04-analysis-papers/p1103-lv.pdf)

## 固定条件

- Books/Movies development。各target groupからSHA-256で1クエリを決定論的に選ぶ。
- 同じ保存済み形態素トークン、query parser、positive-smoothed IDF、k1=1.2、b=0.75、候補集合、qrelsを使用。
- 変更するのは標準BM25のTF saturationからBM25Lへの置換のみ。BM25Lはdelta=0.5。
- 主要指標nDCG@10。paired target-group cluster bootstrap 95%区間。続行候補は差>=0.005かつ下限>0。
- Movies developmentは過去の探索で使用済みなので、独立confirmatory holdoutではない。両セットとも探索的な変種評価として扱う。
- 本番コード、DB、ランキングは変更しない。
