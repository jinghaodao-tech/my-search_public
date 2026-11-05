#!/usr/bin/env python3
"""Analyze one frozen paired rank comparison with the query group as unit."""
import argparse, json, math, pathlib, random
from statistics import NormalDist

def percentile(values, p):
    values=sorted(values); position=(len(values)-1)*p; lo=math.floor(position); hi=math.ceil(position)
    return values[lo] if lo==hi else values[lo]*(hi-position)+values[hi]*(position-lo)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--api',required=True);parser.add_argument('--standard',required=True)
    parser.add_argument('--out',required=True);parser.add_argument('--iterations',type=int,default=20000)
    args=parser.parse_args()
    api=json.loads(pathlib.Path(args.api).read_text(encoding='utf-8'))
    standard=json.loads(pathlib.Path(args.standard).read_text(encoding='utf-8'))
    api_rows=api.get('all_results',[])
    std_rows=standard.get('results',[])
    api_by={row['qid']:row for row in api_rows};std_by={row['qid']:row for row in std_rows}
    if not api_by or set(api_by)!=set(std_by):raise ValueError('API and standard BM25 qid sets differ')
    groups={}
    api_errors=[]
    for qid,row in api_by.items():
        other=std_by[qid]
        if row.get('group_id')!=other.get('groupId'):raise ValueError('Group assignment mismatch')
        prod=int(bool(row.get('success')) and row.get('status')=='ok')
        raw_rank=other.get('rankTop10')
        base=int(isinstance(raw_rank,int) and raw_rank<=10)
        group= row['group_id'];groups.setdefault(group,[]).append((prod,base))
        if row.get('status')!='ok':api_errors.append({'qid':qid,'status':row.get('status')})
    diffs=[sum(a-b for a,b in values)/len(values) for values in groups.values()]
    effect=sum(diffs)/len(diffs)
    rng=random.Random(20261021)
    boot=[]
    for _ in range(args.iterations):
        boot.append(sum(diffs[rng.randrange(len(diffs))] for _ in diffs)/len(diffs))
    more_extreme=0
    for _ in range(args.iterations):
        shuffled=sum(value*(1 if rng.getrandbits(1) else -1) for value in diffs)/len(diffs)
        if shuffled>=effect:more_extreme+=1
    variance=sum((x-effect)**2 for x in diffs)/max(1,len(diffs)-1)
    sd=math.sqrt(variance)
    z=effect*math.sqrt(len(diffs))/sd if sd else (math.inf if effect>0 else 0)
    power=NormalDist().cdf(z-NormalDist().inv_cdf(.95))
    all_pairs=[pair for values in groups.values() for pair in values]
    group_wins=sum(sum(a-b for a,b in values)>0 for values in groups.values())
    group_losses=sum(sum(a-b for a,b in values)<0 for values in groups.values())
    api_ranks=[row.get('rank') if row.get('status')=='ok' else None for row in api_rows]
    standard_ranks=[row.get('rankTop10') or row.get('rankTop100') or row.get('rankTop1000') for row in std_rows]
    def mrr(ranks,k):return sum(1/rank for rank in ranks if isinstance(rank,int) and rank<=k)/len(ranks)
    output={'status':'DESCRIPTIVE_PAIRED_COMPARISON','group_count':len(groups),'query_count':len(api_by),
        'production_api_hit1':sum(rank==1 for rank in api_ranks)/len(api_ranks),
        'production_api_hit10':sum(a for a,_ in all_pairs)/len(all_pairs),
        'production_api_mrr10':mrr(api_ranks,10),
        'standard_bm25_hit1':sum(row.get('rankTop10')==1 for row in std_rows)/len(std_rows),
        'standard_bm25_hit10':sum(row.get('rankTop10') is not None for row in std_rows)/len(std_rows),
        'standard_bm25_mrr10':mrr(standard_ranks,10),
        'standard_bm25_hit100':sum(row.get('rankTop100') is not None for row in std_rows),
        'standard_bm25_hit1000':sum(isinstance(row.get('rankTop1000'),int) and row['rankTop1000']<=1000 for row in std_rows),
        'difference_group_weighted_percentage_points':100*effect,
        'cluster_bootstrap_95_percent_ci_percentage_points':[100*percentile(boot,.025),100*percentile(boot,.975)],
        'one_sided_sign_flip_p_value':(more_extreme+1)/(args.iterations+1),'declared_direction':'production API > independent standard BM25',
        'group_direction_counts':{'production_better':group_wins,'production_worse':group_losses,'tie':len(groups)-group_wins-group_losses},
        'approx_posthoc_power_one_sided_alpha_0_05':power,'api_error_count':len(api_errors),'api_errors':api_errors,
        'latency_api_ms_p50':api.get('latency_ms_median'),'latency_api_ms_p95':api.get('latency_ms_p95'),
        'latency_standard_in_memory_ms_p50':percentile([row['latencyMs'] for row in std_rows],.5),
        'latency_standard_in_memory_ms_p95':percentile([row['latencyMs'] for row in std_rows],.95),
        'inference_unit':'query group (shared gold target); each group equally weighted in effect and bootstrap',
        'caveat':'Fresh group sample from a previously used benchmark source/split, not independent evidence about real saved-article users.'}
    out=pathlib.Path(args.out);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(output,indent=2))

def percentile(values,p):
    values=sorted(values);position=(len(values)-1)*p;lo=math.floor(position);hi=math.ceil(position)
    value=values[lo] if lo==hi else values[lo]*(hi-position)+values[hi]*(position-lo)
    return round(value,2)
if __name__=='__main__':main()
