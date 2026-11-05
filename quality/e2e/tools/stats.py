"""Exact one-sided binomial confidence bound; independent Bernoulli model only."""
import math

def upper_tail(successes,n,p):
    if n<1 or not 0<=successes<=n or not 0<=p<=1:raise ValueError('invalid binomial args')
    if successes==0:return 1.0
    if p==0:return 0.0
    if p==1:return 1.0
    lnp=math.log(p);lnq=math.log1p(-p)
    vals=[math.lgamma(n+1)-math.lgamma(i+1)-math.lgamma(n-i+1)+i*lnp+(n-i)*lnq for i in range(successes,n+1)]
    m=max(vals)
    return min(1.,math.exp(m)*math.fsum(math.exp(v-m) for v in vals))

def lower_exact(successes,n,alpha=0.025):
    if n<1 or not 0<=successes<=n or not 0<alpha<1:raise ValueError('invalid')
    if successes==0:return 0.
    lo,hi=0.,1.
    for _ in range(55):
        mid=(lo+hi)/2
        if upper_tail(successes,n,mid)>=alpha:hi=mid
        else:lo=mid
    return (lo+hi)/2

def certify(k,n,alpha=0.025,threshold=0.95):
    p=upper_tail(k,n,threshold)
    lower=lower_exact(k,n,alpha)
    return {'n':n,'successes':k,'observed':k/n,'lower_exact_one_sided':lower,'p_value_H0_at_threshold':p,'alpha':alpha,'threshold':threshold,'passes':p<alpha and lower>threshold}

if __name__=='__main__':
    assert abs(lower_exact(500,500,0.025)-0.025**(1/500))<1e-10
    assert certify(485,500)['passes']
    assert not certify(475,500)['passes']
    for k in range(501):
        if certify(k,500)['passes']:
            print('500-trial threshold:',k);break
