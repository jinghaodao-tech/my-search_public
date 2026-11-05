#!/usr/bin/env python3
"""Paired query outcome comparison for the SAME corpus+split. Diagnostic, not final certification."""
import argparse,json
from stats import upper_tail
p=argparse.ArgumentParser();p.add_argument('before');p.add_argument('after');a=p.parse_args()
b=json.load(open(a.before,encoding='utf-8'));c=json.load(open(a.after,encoding='utf-8'))
if b['source_sha256']!=c['source_sha256'] or b['stage']!=c['stage'] or b['domain']!=c['domain']:
    raise SystemExit('Invalid paired comparison: corpus/domain/split mismatch')
brows={x['qid']:x for x in b['all_results']};crows={x['qid']:x for x in c['all_results']}
if brows.keys()!=crows.keys():raise SystemExit('Query set differs')
win=sum(not brows[q]['success'] and crows[q]['success'] for q in brows)
loss=sum(brows[q]['success'] and not crows[q]['success'] for q in brows)
n=len(brows)
print(json.dumps({'n':n,'before_Hit10':sum(x['success'] for x in brows.values())/n,
    'after_Hit10':sum(x['success'] for x in crows.values())/n,'new_hits':win,'regressions':loss,
    'net_improvement':(win-loss)/n,'one_sided_exact_p_for_discordant_pairs':upper_tail(win,win+loss,.5) if win+loss else 1.,
    'note':'Exploratory if queries reused in iterative tuning. Report ALL regressions; never turn development p-values into real-use certification.'},indent=2))
