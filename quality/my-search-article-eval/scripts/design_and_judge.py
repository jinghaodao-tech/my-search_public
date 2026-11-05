#!/usr/bin/env python3
"""Freeze planned split, produce BLANK natural-query annotation sheets and evaluate strict holdout.
Pure Python standard library. Corpus articles do not substitute for independently sourced queries.
"""
import argparse,csv,hashlib,json,math,pathlib,statistics,sys

def get_rows(p):
    return [json.loads(l) for l in pathlib.Path(p).read_text(encoding='utf-8').splitlines() if l.strip()]

def logbinom_tail(k,n,p):
    if k<=0:return 1.
    if k>n:return 0.
    if p<=0:return 0.
    if p>=1:return 1.
    def logmass(j):return math.lgamma(n+1)-math.lgamma(j+1)-math.lgamma(n-j+1)+j*math.log(p)+(n-j)*math.log1p(-p)
    masses=[logmass(j) for j in range(k,n+1)]
    high=max(masses)
    return min(1.,math.exp(high)*sum(math.exp(x-high) for x in masses))

def lower_bound(k,n,alpha=.025):
    if not n or k==0:return 0.
    low,high=0.,k/n
    for _ in range(70):
        mid=(low+high)/2
        if logbinom_tail(k,n,mid)>alpha:high=mid
        else:low=mid
    return (low+high)/2

def min_success(n,alpha=.025,p0=.95):
    lo,hi=0,n+1
    while lo<hi:
        mid=(lo+hi)//2
        if logbinom_tail(mid,n,p0)<=alpha:hi=mid
        else:lo=mid+1
    return lo

def plan(args):
    out=pathlib.Path(args.output);out.mkdir(parents=True,exist_ok=True)
    docs=get_rows(args.corpus)
    ids=[x['id'] for x in docs]
    if len(ids)!=len(set(ids)):raise ValueError('Duplicate document IDs')
    if len(docs)<args.minimum_docs:
        print('NOT_EVALUABLE: too few articles',len(docs),'required',args.minimum_docs);sys.exit(2)
    # Fixed, reproducible assignment; no query text/relevance in assignment.
    ordered=sorted(docs,key=lambda x:hashlib.sha256(('my-search-docsplit-v1|'+x['id']).encode()).hexdigest())
    train=ordered[:400];val=ordered[400:800];holdout=ordered[800:2000]
    # Do not expose holdout labels during tuning; store privately and never edit after preregistration.
    for name,data in [('development',train),('validation',val),('sealed_holdout',holdout)]:
        with (out/(name+'_annotation_blank.csv')).open('w',encoding='utf-8',newline='') as f:
            w=csv.DictWriter(f,fieldnames=['query_id','target_doc_id','query_text','query_origin','query_author_group','relevance_judged_before_results','notes'])
            w.writeheader()
            for i,x in enumerate(data):w.writerow({'query_id':name+'-'+str(i+1).zfill(4),'target_doc_id':x['id']})
    meta={'sampling_rule':'hash(document id), fixed deterministic; 1 intended target per query',
          'minimum_docs':args.minimum_docs,'total_documents':len(docs),'development_targets':len(train),
          'validation_targets':len(val),'sealed_holdout_targets':len(holdout),
          'population_scope':'collected public technology articles, NOT actual my-search usage',
          'holdout_query_requirement':'Must obtain independent query text and adjudicated target BEFORE observing model predictions',
          'queries_are_currently_present':False,
          'holdout_pair_sha256':hashlib.sha256(('\n'.join('sealed_holdout-'+str(i+1).zfill(4)+'|'+x['id'] for i,x in enumerate(holdout))).encode()).hexdigest(),
          'corpus_sha256':hashlib.sha256(pathlib.Path(args.corpus).read_bytes()).hexdigest()}
    (out/'study_plan.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(meta,ensure_ascii=False,indent=2))

def judge(args):
    p=pathlib.Path(args.predictions); rows=get_rows(p)
    # Prediction record: query_id, target_doc_id, query_origin, query_author_group, success10, fixed_build, ...
    plan=json.loads(pathlib.Path(args.plan).read_text(encoding='utf-8'))
    n=args.n
    if n != plan['sealed_holdout_targets']:raise ValueError('n != preregistered number of holdout targets')
    if len(rows)!=n:
        print('NOT_EVALUABLE: expected',n,'holdout queries, received',len(rows));sys.exit(2)
    if len({r['query_id'] for r in rows})!=n:raise ValueError('Repeated query ID')
    registered=list(csv.DictReader((pathlib.Path(args.plan).parent/'sealed_holdout_annotation_blank.csv').open(encoding='utf-8',newline='')))
    expected={r['query_id']:r['target_doc_id'] for r in registered}
    if len(expected)!=n or any(expected.get(r['query_id'])!=r['target_doc_id'] for r in rows):
        raise ValueError('Predictions do not match preregistered holdout query/target pairs')
    fingerprint=hashlib.sha256(('\n'.join(k+'|'+v for k,v in expected.items())).encode()).hexdigest()
    if fingerprint!=plan['holdout_pair_sha256']: raise ValueError('Holdout preregistration changed')
    if len({r['target_doc_id'] for r in rows})!=n:raise ValueError('Repeated target document, cluster structure not accounted for')
    if len({r['fixed_build'] for r in rows})!=1:raise ValueError('Multiple builds')
    allowed={'organic'} if args.require_organic else {'organic','blind-human'}
    if any(r.get('query_origin') not in allowed for r in rows):
        print('NOT_EVALUABLE: generated/self-derived/unclassified query present');sys.exit(2)
    if any(not r.get('query_author_group') for r in rows):
        print('NOT_EVALUABLE: missing author/user grouping');sys.exit(2)
    if any(r.get('relevance_judged_before_results') is not True for r in rows):
        print('NOT_EVALUABLE: relevance judged after results or missing');sys.exit(2)
    if any(type(r.get('success10')) is not bool for r in rows):raise ValueError('success10 must be true/false; errors count as false')
    group_count=len(set(r['query_author_group'] for r in rows))
    if group_count!=len(rows):
        print('NOT_EVALUABLE: repeated query author/participant; independent binomial certification not justified. Use preregistered cluster analysis.')
        sys.exit(2)
    success=sum(r['success10'] for r in rows)
    lower=lower_bound(success,n)
    result={'n':n,'success':success,'hit10':success/n,'one_sided_confidence_level':.975,
            'clopper_pearson_lower':lower,'threshold':.95,'passed':lower>.95,
            'pvalue_right_tail_null_p95':logbinom_tail(success,n,.95),
            'scope':'Constructed corpus/query sampling scheme; not proof of all end-users',
            'build':rows[0]['fixed_build']}
    dest=pathlib.Path(args.report);dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(result,indent=2,ensure_ascii=False))

def samples(args):
    print('One-sided exact binomial test H0:p<=.95, alpha=.025; assumes independent representative queries')
    for n in [300,500,800,900,1000,1200,1500,2000]:
        k=min_success(n)
        print(f'n={n}  pass_if>={k}  observed={k/n:.4%}  power(p=.97)={logbinom_tail(k,n,.97):.1%}  power(p=.98)={logbinom_tail(k,n,.98):.1%}')

def main():
    parser=argparse.ArgumentParser();s=parser.add_subparsers(dest='cmd',required=True)
    p=s.add_parser('plan');p.add_argument('--corpus',default='local_article_corpus/articles.jsonl');p.add_argument('--output',default='local_article_corpus/plan');p.add_argument('--minimum-docs',type=int,default=2000);p.set_defaults(func=plan)
    p=s.add_parser('judge');p.add_argument('--predictions',required=True);p.add_argument('--plan',required=True);p.add_argument('--n',type=int,default=1200);p.add_argument('--report',default='local_article_corpus/final_report.json');p.add_argument('--require-organic',action='store_true');p.set_defaults(func=judge)
    p=s.add_parser('sample-sizes');p.set_defaults(func=samples)
    args=parser.parse_args();args.func(args)
if __name__=='__main__':main()
