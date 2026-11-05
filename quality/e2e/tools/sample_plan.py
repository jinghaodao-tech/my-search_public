#!/usr/bin/env python3
"""Pre-register n/alpha for an independent Bernoulli model; not a representativeness guarantee."""
import argparse,json
from stats import upper_tail
p=argparse.ArgumentParser();p.add_argument('--n',type=int,default=500);p.add_argument('--true-rate',type=float,default=.98)
p.add_argument('--attempt',type=int,default=1);p.add_argument('--threshold',type=float,default=.95)
a=p.parse_args()
if not(0<a.threshold<a.true_rate<=1 and 0<a.n<=50000 and a.attempt>=1):raise SystemExit('invalid plan')
alpha=.05/(a.attempt*(a.attempt+1))
lo,hi=0,a.n+1
while lo<hi:
    mid=(lo+hi)//2
    if mid<=a.n and upper_tail(mid,a.n,a.threshold)<alpha:hi=mid
    else:lo=mid+1
k=lo
print(json.dumps({'n':a.n,'attempt':a.attempt,'allocated_alpha':alpha,'null_rate':a.threshold,
   'successes_required':k if k<=a.n else 'IMPOSSIBLE',
   'maximum_failures':a.n-k if k<=a.n else None,
   'power_at_assumed_true_rate':upper_tail(k,a.n,a.true_rate) if k<=a.n else 0,
   'caveat':'Valid for independent representative Bernoulli trials only; one person or repeated items may be dependent.'},indent=2))
