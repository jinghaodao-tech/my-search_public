# BM25 Benchmark 日本語版

BM25検索の速度を、コーパスサイズ別に再現可能な形で測定します。

実行コマンド:

```bash
npm run benchmark
```

測定対象:

- DB load time
- Token parse / preparation time
- BM25 scoring time
- Sorting / limiting time
- Total search time

## 改善内容

以前は検索時に毎回トークン化していました。現在はカード保存時に `tokens_json` と `doc_length` を生成し、検索時に再利用します。

| Stage | Before | After |
|---|---:|---:|
| Load cards | 2.175 ms | 7.054 ms |
| Tokenize | 4.584 s | 0.464 ms |
| Score | 4.705 s | 40.778 ms |
| Total BM25 | 9.705 s | 1.413 s |

最大の改善は、検索ごとの形態素解析をなくしたことです。一方で、DBアクセス、集計、ソートは今後のボトルネック候補です。

## 注意

ベンチマーク値は実行環境によって変動します。特に初回実行ではtokenizer warm-upの影響を受けることがあります。
