#!/usr/bin/env python3
"""Analyze a preregistered paired, target-clustered holdout comparison."""
import argparse, json, pathlib, random

def load(path):
    data=json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    profiles=data.get('profiles')
    if not profiles or set(profiles)!={'current','stopwords-morphology-only'}:
        raise ValueError('Expected the preregistered current vs stopwords-morphology-only paired report')
    left={row['qid']:row for row in profiles['current']['all_results']}
    right={row['qid']:row for row in profiles['stopwords-morphology-only']['all_results']}
    if not left or left.keys()!=right.keys():raise ValueError('Profile query sets differ')
    clusters={}
    for qid,a in left.items():
        b=right[qid]
        if a['group_id']!=b['group_id']:raise ValueError('Group assignment changed for '+qid)
        group=clusters.setdefault(a['group_id'],[0,0,0])
        group[0]+=int(b['success'])-int(a['success'])
        group[1]+=1
        group[2]+=int(b['success']!=a['success'])
    return data,clusters

def analyze(data,clusters,replicates=100_000,seed=20261020):
    groups=list(clusters.values());n=sum(g[1] for g in groups)
    successes={p:sum(r['success'] for r in data['profiles'][p]['all_results']) for p in ('current','stopwords-morphology-only')}
    request_errors={p:sum(r['status']!='ok' for r in data['profiles'][p]['all_results']) for p in successes}
    observed=sum(g[0] for g in groups)/n
    rng=random.Random(seed);extreme=0
    for _ in range(replicates):
        permuted=sum(g[0] if rng.getrandbits(1) else -g[0] for g in groups)/n
        if permuted>=observed-1e-15:extreme+=1
    p_value=(extreme+1)/(replicates+1)

    boots=[];count=len(groups)
    for _ in range(replicates):
        total_delta=total_queries=0
        for _ in range(count):
            g=groups[rng.randrange(count)];total_delta+=g[0];total_queries+=g[1]
        boots.append(total_delta/total_queries)
    boots.sort()
    lower=boots[int(0.025*(replicates-1))];upper=boots[int(0.975*(replicates-1))]
    wins=sum(g[0]>0 for g in groups);losses=sum(g[0]<0 for g in groups);ties=count-wins-losses
    return {
        'queries':n,'independent_target_groups':count,
        'hit_at_10':{p:{'successes':successes[p],'rate':successes[p]/n} for p in successes},
        'request_errors_counted_as_misses':request_errors,
        'candidate_minus_current':observed,'difference_percentage_points':observed*100,
        'paired_target_groups':{'candidate_better':wins,'current_better':losses,'tie':ties},
        'cluster_sign_flip_randomization':{'alternative':'candidate_hit10_improves','p_value_one_sided':p_value,
            'alpha':0.05,'replicates':replicates,'seed':seed},
        'cluster_bootstrap_95_percentile_interval':{'lower':lower,'upper':upper,'replicates':replicates,'seed':seed},
        'supports_preregistered_improvement':p_value<0.05 and lower>0,
        'latency_ms':{p:{'p50':data['profiles'][p]['latency_ms_median'],'p95':data['profiles'][p]['latency_ms_p95']}
            for p in successes},
        'interpretation':'Conditional to this Movies benchmark; not evidence for real saved-article refinding.'
    }

def main():
    parser=argparse.ArgumentParser();parser.add_argument('report');parser.add_argument('--out')
    args=parser.parse_args();data,clusters=load(args.report);result=analyze(data,clusters)
    text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.out:pathlib.Path(args.out).write_text(text,encoding='utf-8')
    print(text,end='')

if __name__=='__main__':main()
