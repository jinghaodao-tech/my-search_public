#!/usr/bin/env python3
"""Holdout one-sided exact binomial lower-bound gate. Use only for preregistered held-out evals.

Read-only on datasets; should not be used to repeatedly try new model settings on holdout.
"""
import argparse
import json
from pathlib import Path
from collections import Counter, defaultdict

def read_jsonl(path):
    with open(path, encoding='utf-8') as f:
        for ln in f:
            if ln.strip(): yield json.loads(ln)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--dataset-dir', type=Path, required=True)
    p.add_argument('--results',type=Path,required=True)
    p.add_argument('--alpha',type=float,default=.025)
    p.add_argument('--target',type=float,default=.95)
    args=p.parse_args()
    from scipy.stats import beta
    manifest=json.loads((args.dataset_dir/'manifest.json').read_text(encoding='utf-8'))
    if not manifest.get('full_corpus_available'):raise ValueError('Full corpus unavailable, not a valid global retrieval evaluation')
    split={x['id']:x for x in read_jsonl(args.dataset_dir/'splits.jsonl')}
    ids={k for k,v in split.items() if v['split']=='holdout'}
    if not ids:raise ValueError('No holdout cases')
    answers=list(read_jsonl(args.results))
    seen={};
    for a in answers:
        qid=a.get('id'); v=a.get('hit10')
        if qid in seen:raise ValueError(f'duplicate result {qid}')
        if qid not in ids:raise ValueError(f'Non-holdout result found {qid}')
        if type(v) is not bool:raise ValueError(f'Invalid hit10 {qid}: must be bool')
        seen[qid]=v
    if set(seen)!=ids:raise ValueError(f'Incomplete holdout: expected {len(ids)}, got {len(seen)}')
    n=len(ids);k=sum(seen.values());p=k/n
    lower=0.0 if k==0 else float(beta.ppf(args.alpha,k,n-k+1))
    groups=defaultdict(list)
    for qid in ids:groups[split[qid]['group_id']].append(qid)
    repeated=[g for g,v in groups.items() if len(v)>1]
    report={'status':'NOT_EVALUABLE' if repeated else ('PASS' if lower>args.target else 'FAIL'),
        'n':n,'hits':k,'observed':p,'one_sided_lower_confidence_bound':lower,
        'alpha':args.alpha,'threshold':args.target,'clusters':len(groups),
        'repeated_clusters':len(repeated),'reason':('correlated target groups: use preregistered cluster-aware inference' if repeated else None),
        'scope':manifest['dataset'],'notice':'not a product-wide my-search real-world refinding rate'}
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
