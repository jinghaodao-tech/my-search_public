#!/usr/bin/env python3
"""Summarize paired API and standard-BM25 development/validation runs."""
import argparse, json, math, pathlib

def percentile(values, p):
    ordered=sorted(values)
    return round(ordered[min(len(ordered)-1,int(p*len(ordered)))],3) if ordered else None

def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))

def summarize(root, stage):
    base=pathlib.Path(root)
    api=read(base/'benchmark'/f'{stage}-baseline.json')
    std=read(base/'benchmark'/f'{stage}-standard-bm25.json')
    api_rows=api['all_results']; std_rows={row['qid']:row for row in std['results']}
    if set(row['qid'] for row in api_rows)!=set(std_rows): raise ValueError('API and standard BM25 query IDs differ')
    paired={'both_hit10':0,'api_only_hit10':0,'standard_only_hit10':0,'neither_hit10':0}
    for row in api_rows:
        api_hit=bool(row.get('rank'))
        std_hit=bool(std_rows[row['qid']].get('rankTop10'))
        paired[('both_hit10' if api_hit else 'standard_only_hit10') if std_hit else ('api_only_hit10' if api_hit else 'neither_hit10')]+=1
    n=len(api_rows)
    api_rank=[row.get('rank') for row in api_rows]
    api_diag=[row.get('diagnostic_rank') for row in api_rows]
    std_rank=[row.get('rankTop10') for row in std_rows.values()]
    std_100=[row.get('rankTop100') for row in std_rows.values()]
    std_1000=[row.get('rankTop1000') for row in std_rows.values()]
    return {
        'n':n,
        'api':{
            'hit1':sum(rank==1 for rank in api_rank)/n,
            'hit10':sum(bool(rank) for rank in api_rank)/n,
            'mrr10':sum(1/rank for rank in api_rank if rank)/n,
            'ndcg10':sum(1/math.log2(rank+1) for rank in api_rank if rank)/n,
            'hit100':sum(bool(rank and rank<=100) for rank in api_diag)/n,
            'target_rank_observed_through_500':sum(bool(rank and rank<=500) for rank in api_diag)/n,
            'api_errors':sum(row.get('status')!='ok' for row in api_rows),
            'latency_p50_ms':api['latency_ms_median'],
            'latency_p95_ms':api['latency_ms_p95'],
        },
        'standard_bm25':{
            'hit1':sum(rank==1 for rank in std_rank)/n,
            'hit10':sum(bool(rank) for rank in std_rank)/n,
            'mrr10':sum(1/rank for rank in std_rank if rank)/n,
            'ndcg10':sum(1/math.log2(rank+1) for rank in std_rank if rank)/n,
            'hit100':sum(bool(rank) for rank in std_100)/n,
            'hit1000':sum(bool(rank and rank<=1000) for rank in std_1000)/n,
            'ranker_latency_p50_ms':percentile([row['latencyMs'] for row in std['results']],.5),
            'ranker_latency_p95_ms':percentile([row['latencyMs'] for row in std['results']],.95),
        },
        'paired_hit10':paired,
        'inference':'descriptive only; queries are self-derived from title/tags and are not natural-query evidence',
    }

def main():
    p=argparse.ArgumentParser();p.add_argument('--corpus',default='local_article_corpus');p.add_argument('--output',default='local_article_corpus/benchmark/paired-summary.json');a=p.parse_args()
    result={stage:summarize(a.corpus,stage) for stage in ('development','validation')}
    target=pathlib.Path(a.output);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
