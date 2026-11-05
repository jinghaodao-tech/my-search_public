#!/usr/bin/env python3
"""Prospective real-use Hit@10 research, explicit consent and locally stored data.
This is a CLI fall-back; Codex can integrate equivalent event capture in the my-search UI.
Do NOT generate synthetic participants, queries, targets or relevance labels.
"""
import argparse, datetime as dt, hashlib, json, os, pathlib, shutil, time, urllib.parse, urllib.request, uuid
from collections import Counter
from stats import certify
ROOT=pathlib.Path(__file__).resolve().parents[1]
STUDY=ROOT/'study'

def sha(b):return hashlib.sha256(b).hexdigest()
def canon(obj):return json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')
def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def require_local(base):
    u=urllib.parse.urlparse(base)
    if u.scheme!='http' or u.hostname not in ('localhost','127.0.0.1','::1') or (u.path not in ('','/')):raise ValueError('Only localhost HTTP API accepted for private queries')
def protocol():
    p=STUDY/'protocol.json'
    expire_archived_studies()
    if not p.exists():raise ValueError('No preregistered protocol: run `init` first')
    cfg=json.loads(p.read_text(encoding='utf-8'))
    if expire_if_past_due(cfg):raise ValueError('Retention expired; raw study data was automatically deleted')
    return cfg
def expire_if_past_due(cfg=None):
    p=STUDY/'protocol.json'
    if cfg is None:
        if not p.exists():return False
        cfg=json.loads(p.read_text(encoding='utf-8'))
    raw=cfg.get('expires_utc')
    if not isinstance(raw,str):return False
    expiry=dt.datetime.fromisoformat(raw.replace('Z','+00:00'))
    if expiry.tzinfo is None:expiry=expiry.replace(tzinfo=dt.timezone.utc)
    if expiry>dt.datetime.now(dt.timezone.utc):return False
    registry=STUDY/'registry.json'
    old=json.loads(registry.read_text(encoding='utf-8')) if registry.exists() else {'attempts':[]}
    if not any(item.get('study_id')==cfg.get('study_id') for item in old['attempts']):
        old['attempts'].append({'study_id':cfg.get('study_id'),'attempt':cfg.get('attempt'),
                                'status':'EXPIRED_BY_RETENTION','expired_utc':now()})
    shutil.rmtree(STUDY,ignore_errors=True)
    STUDY.mkdir(parents=True,exist_ok=True)
    (STUDY/'registry.json').write_text(json.dumps(old,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return True
def expire_archived_studies():
    archive=ROOT/'study_archive'
    if not archive.exists():return
    for directory in archive.iterdir():
        p=directory/'protocol.json'
        if not directory.is_dir() or not p.exists():continue
        cfg=json.loads(p.read_text(encoding='utf-8'))
        raw=cfg.get('expires_utc')
        if not isinstance(raw,str):continue
        expiry=dt.datetime.fromisoformat(raw.replace('Z','+00:00'))
        if expiry.tzinfo is None:expiry=expiry.replace(tzinfo=dt.timezone.utc)
        if expiry>dt.datetime.now(dt.timezone.utc):continue
        STUDY.mkdir(parents=True,exist_ok=True)
        registry=STUDY/'registry.json'
        old=json.loads(registry.read_text(encoding='utf-8')) if registry.exists() else {'attempts':[]}
        if not any(item.get('study_id')==cfg.get('study_id') for item in old['attempts']):
            old['attempts'].append({'study_id':cfg.get('study_id'),'attempt':cfg.get('attempt'),
                                    'status':'EXPIRED_BY_RETENTION','expired_utc':now()})
        shutil.rmtree(directory)
        registry.parent.mkdir(parents=True,exist_ok=True)
        registry.write_text(json.dumps(old,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def events():
    p=STUDY/'events.jsonl'
    if not p.exists():return [],sha(b'')
    rows=[];prev='genesis'
    # JSON strings may contain U+2028/U+2029; only LF separates JSONL records.
    for line in p.read_text(encoding='utf-8').split('\n'):
        if not line.strip():continue
        e=json.loads(line)
        if e.get('previous_hash')!=prev:raise ValueError('Event journal hash chain altered')
        h=e.get('hash'); e2={k:v for k,v in e.items() if k!='hash'}
        if h!=sha(canon(e2)):raise ValueError('Event journal hash invalid')
        rows.append(e);prev=h
    return rows,sha(p.read_bytes())
def append(kind,fields):
    rows,_=events()
    e={'kind':kind,'at':now(),**fields,'previous_hash':rows[-1]['hash'] if rows else 'genesis'}
    e['hash']=sha(canon(e))
    p=STUDY/'events.jsonl'
    with p.open('a',encoding='utf-8') as f:f.write(json.dumps(e,ensure_ascii=False)+'\n');f.flush();os.fsync(f.fileno())
    return e

def search_saved_cards_ui(base,query):
    analysis=request(base,'POST','/api/search/terms',{'text':query},timeout=20)
    modes=request(base,'GET','/api/modes',timeout=20)
    if not isinstance(modes,dict) or not modes:raise ValueError('No search mode available')
    mode=next(iter(modes.values()))
    config={'label':'検索','description':mode.get('description',''),'k1':mode['k1'],'b':mode['b'],
            'lambda':mode['lambda'],'contextBonus':mode['contextBonus'],
            'keywords':[{'term':x['term'],'weight':x['weight'],'synonyms':[]} for x in analysis['keywords']]}
    result=request(base,'POST','/api/cards/search',{'config':config,
        'options':{'dedupThreshold':0.8,'archiveScoreThreshold':0.5,'resultLimit':50},
        'filters':{'excludedTerms':[],'sources':[],'status':'all'}},timeout=45)
    return [x.get('article',{}).get('id') for x in result.get('active',[])[:10]
            if isinstance(x.get('article',{}).get('id'),str)]

def collected(rows):
    trials={};answers={}
    for e in rows:
        if e['kind']=='session':
            if e['sid'] in trials:raise ValueError('duplicate session id')
            trials[e['sid']]=e
        elif e['kind']=='adjudication':
            if e['sid'] in answers:raise ValueError('duplicate adjudication id')
            answers[e['sid']]=e
        elif e['kind']=='interaction':
            if e.get('sid') not in trials:raise ValueError('interaction for missing session')
            trials[e['sid']].setdefault('_interactions',[]).append(e)
        else:raise ValueError('unknown event')
    if any(sid not in trials for sid in answers):raise ValueError('adjudication for missing session')
    return trials,answers

def init(a):
    expire_archived_studies()
    STUDY.mkdir(exist_ok=True)
    expire_if_past_due()
    if any((STUDY/x).exists() for x in ('protocol.json','events.jsonl','seal.json')):raise ValueError('Study already initialized, do not overwrite data')
    if not a.build_id or a.build_id.startswith('REPLACE_'):raise ValueError('Supply real frozen source fingerprint')
    if a.n<1:raise ValueError('n invalid')
    retention_days=getattr(a,'retention_days',30)
    if not 1<=retention_days<=3650:raise ValueError('--retention-days must be between 1 and 3650')
    registry=STUDY/'registry.json'
    old=json.loads(registry.read_text()) if registry.exists() else {'attempts':[]}
    attempt=len(old['attempts'])+1
    cfg={'study_id':str(uuid.uuid4()),'attempt':attempt,'planned_n':a.n,'build_id':a.build_id,
         'scope':a.scope,'target_population':a.population,'success':'Both: first natural query contains intended saved card in Top10; AND within 180 seconds and at most 3 queries the user actually opens that card',
         'retention':f'Raw study data is automatically deleted after {retention_days} days',
         'retention_days':retention_days,
         'expires_utc':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(days=retention_days)).isoformat(),
         'max_seconds':180,'max_queries':3,
         'sampling':'consecutive eligible prospective first searches with consent; retain failures',
         'alpha':0.05/(attempt*(attempt+1)),'min_true_rate':0.95,
         'created_utc':now(),'collection_started':False,'preregistered':True,
         'ethical':'explicit opt-in; no query transmission beyond local my-search; no passwords/PII in questions',
         'limitations':'Participant representativeness and independence cannot be demonstrated by software alone; participant IDs are self-reported pseudonyms.'}
    if cfg['scope']=='multi-user' and a.n<30:raise ValueError('multi-user sample insufficient by protocol convention; use >=30')
    (STUDY/'protocol.json').write_text(json.dumps(cfg,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(cfg,indent=2,ensure_ascii=False))

def record(a):
    cfg=protocol();require_local(a.base)
    if (STUDY/'seal.json').exists():raise ValueError('Study sealed')
    if cfg['build_id']!=a.build_id:raise ValueError('Frozen build fingerprint mismatch')
    rows,_=events();trials,_=collected(rows)
    if len(trials)>=cfg['planned_n']:raise ValueError('Planned sample complete, do not collect extra results selectively')
    if cfg['scope']=='multi-user' and a.participant in {t['participant'] for t in trials.values()}:
        raise ValueError('One first eligible session per participant in multi-user protocol')
    print('入力前に対象カードのタイトル・本文や検索結果を参照しないでください。自然な初回検索のみ記録します。')
    query=input('検索語（この入力後ただちに検索・記録）: ').strip()
    if not query or len(query)>4000:raise ValueError('Search query must be 1..4000 chars')
    sid=str(uuid.uuid4());started_at=now();t=time.monotonic()
    result_ids=[];error=None;status=None
    try:
        result_ids=search_saved_cards_ui(a.base,query)
        status=200
    except Exception as e:error=str(e)[:300]
    elapsed=round((time.monotonic()-t)*1000,1)
    rec=append('session',{'at':started_at,'sid':sid,'study_id':cfg['study_id'],'participant':a.participant,'build_id':cfg['build_id'],
                          'query':query,'top10':result_ids,'latency_ms':elapsed,'http_status':status,'error':error,
                          'source':'human-typed-live-ui-equivalent-local-api','consent_declared':True})
    print('記録ID:',sid,'結果数:',len(result_ids),'エラー:',error or 'なし')
    print('その後、実際に探していたカードを確認し、resolveで正解IDまたは不明を申告してください。')

def resolve(a):
    protocol()
    rows,_=events();trials,answers=collected(rows)
    if (STUDY/'seal.json').exists():raise ValueError('sealed')
    if a.sid not in trials:raise ValueError('Unknown session')
    if a.sid in answers:raise ValueError('Already adjudicated; do not edit label')
    if bool(a.gold)==bool(a.unknown):raise ValueError('Provide either --gold or --unknown')
    if a.gold and not a.human_checked:raise ValueError('Human must manually verify target id; add --human-checked')
    if a.opened_card and not a.gold:raise ValueError('Cannot record opened target without verified gold')
    if a.opened_card and (a.seconds is None or a.queries is None or a.seconds<0 or a.queries<1):
        raise ValueError('When opened, need --seconds and --queries, measured from first search')
    if a.gold and not (a.opened_card or a.not_opened):
        raise ValueError('Must provide --opened-card or --not-opened to evaluate end-to-end retrieval')
    append('adjudication',{'sid':a.sid,'gold_id':a.gold or None,'status':'verified' if a.gold else 'unresolved',
                           'reviewed_by_human':bool(a.human_checked),'opened_card_id':a.opened_card or None,
                           'elapsed_seconds':a.seconds,'query_count':a.queries,'label_note':a.note or '',
                           'human_declared':True})
    print('Adjudication recorded. Cannot amend or delete it in this cohort.')

def progress(_a):
    cfg=protocol();rows,_=events();trials,ans=collected(rows)
    cutoff=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=180)
    for sid,trial in trials.items():
        started=dt.datetime.fromisoformat(trial['at'].replace('Z','+00:00'))
        if sid in ans or started>cutoff:continue
        interactions=trial.get('_interactions',[])
        append('adjudication',{'sid':sid,'gold_id':None,'status':'unresolved','reviewed_by_human':False,
            'opened_card_id':None,'elapsed_seconds':None,
            'query_count':1+sum(event.get('action')=='query' for event in interactions),
            'response_count':sum(event.get('action')=='search_response' for event in interactions),
            'human_declared':False,'ended_by_timeout':True})
    rows,_=events();trials,ans=collected(rows)
    print(json.dumps({'collected':len(trials),'planned':cfg['planned_n'],'adjudicated':len(ans), 'remaining':max(0,cfg['planned_n']-len(trials)),
                     'note':'Success counts intentionally hidden until final lock and certification. Sessions past 180 seconds without a human resolution are recorded as failures.'},indent=2))

def seal(_a):
    cfg=protocol();rows,digest=events();t,ans=collected(rows)
    if len(t)!=cfg['planned_n'] or len(ans)!=len(t):raise ValueError(f'Need {cfg["planned_n"]} sessions AND adjudications; got {len(t)} {len(ans)}')
    if cfg['scope']=='multi-user' and len(set(x['participant'] for x in t.values()))!=len(t):raise ValueError('multi-user unit independence violation')
    if any(x['build_id']!=cfg['build_id'] for x in t.values()):raise ValueError('build changed')
    if (STUDY/'seal.json').exists():raise ValueError('Already sealed')
    s={'study_id':cfg['study_id'],'config_sha':sha((STUDY/'protocol.json').read_bytes()), 'journal_sha':digest,
       'sealed_utc':now(),'n':len(t),'attempt':cfg['attempt']}
    with (STUDY/'seal.json').open('x',encoding='utf-8') as f:json.dump(s,f,indent=2,ensure_ascii=False)
    print('Sealed:',s['study_id'])

def final(_a):
    cfg=protocol();sfile=STUDY/'seal.json'
    if not sfile.exists():
        print(json.dumps({'status':'NOT_EVALUABLE','reason':'Missing prospective sealed real sessions; cannot fabricate'},ensure_ascii=False));return
    s=json.loads(sfile.read_text(encoding='utf-8'))
    rows,digest=events();t,ans=collected(rows)
    if sha((STUDY/'protocol.json').read_bytes())!=s['config_sha'] or digest!=s['journal_sha']:raise ValueError('Sealed data modified')
    if len(t)!=cfg['planned_n'] or len(ans)!=len(t):raise ValueError('Count mismatch')
    regfile=STUDY/'registry.json'
    reg=json.loads(regfile.read_text()) if regfile.exists() else {'attempts':[]}
    if reg['attempts'] and any(r['study_id']==cfg['study_id'] or r['journal_sha']==digest for r in reg['attempts']):raise ValueError('This cohort already certified; no peeking/redo')
    if cfg['attempt']!=len(reg['attempts'])+1:raise ValueError('Attempt registry mismatch')
    first_hits=0;session_hits=0;unknown=0
    for sid,x in t.items():
        a=ans[sid]
        interactions=x.get('_interactions',[])
        response=next((event for event in interactions if event.get('action')=='search_response'),None)
        top10=response.get('top10',[]) if response else x.get('top10',[])
        error=response.get('error') if response else x.get('error')
        opened=next((event for event in interactions if event.get('action')=='opened'),None)
        opened_id=a.get('opened_card_id') or (opened.get('card_id') if opened else None)
        elapsed=a.get('elapsed_seconds')
        if elapsed is None and opened:
            elapsed=max(0,(dt.datetime.fromisoformat(opened['at'].replace('Z','+00:00'))-dt.datetime.fromisoformat(x['at'].replace('Z','+00:00'))).total_seconds())
        query_count=a.get('query_count') or (1+sum(event.get('action')=='query' for event in interactions))
        if a['status']=='verified':
            first_hits+=int(a['gold_id'] in top10 and error is None)
            session_hits+=int(opened_id==a['gold_id'] and error is None
                              and isinstance(elapsed,(int,float))
                              and 0<=elapsed<=cfg['max_seconds']
                              and isinstance(query_count,int) and 1<=query_count<=cfg['max_queries'])
        else:unknown+=1
    result={'first_query_hit10':certify(first_hits,len(t),cfg['alpha'],cfg['min_true_rate']),
            'end_to_end_session':certify(session_hits,len(t),cfg['alpha'],cfg['min_true_rate'])}
    # Intersection-union claim: BOTH must pass at alpha. This controls type-I error for the joint claim
    # H0: first-query p <=.95 OR session p <=.95; does not license separate unrelated claims.
    both_pass=(result['first_query_hit10']['passes'] and result['end_to_end_session']['passes'])
    distinct=len({x['participant'] for x in t.values()})
    structurally_ok=(cfg['scope']!='multi-user' or distinct==len(t))
    status=('STATISTICALLY_SUPPORTED_CONDITIONAL' if both_pass and structurally_ok and cfg['scope']=='multi-user'
            else 'PERSONAL_EXPLORATORY_ONLY' if cfg['scope']=='personal-longitudinal' else 'NOT_CERTIFIED')
    result.update({'status':status,'study_id':cfg['study_id'],'scope':cfg['scope'],'attempt':cfg['attempt'],
                   'distinct_participants':distinct,'unknown_labels_counted_failure':unknown,
                   'source':'locally recorded prospective human queries, claimed by operator',
                   'joint_claim':'Both first-query Hit@10 and end-to-end opening within 180s/3 queries exceed 95% (requires BOTH exact tests to pass; intersection-union).',
                   'limitations':['Hash chain is an audit aid, not proof that a human actually entered each record.',
                                  'Sample representativeness, consent and independence require external human audit.',
                                  'One person repeatedly testing does NOT prove cross-user performance.',
                                  'Search outcome is first-query Hit@10, not full-session success or latency threshold.']})
    with (STUDY/'final.json').open('x',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    reg['attempts'].append({'study_id':cfg['study_id'],'journal_sha':digest,'attempt':cfg['attempt'],'status':status})
    regfile.write_text(json.dumps(reg,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))

def next_study(_a):
    cfg=protocol()
    if not (STUDY/'final.json').exists() or not (STUDY/'seal.json').exists():
        raise ValueError('Current study has not been sealed and certified. Do not discard incomplete studies.')
    archive=ROOT/'study_archive'/cfg['study_id']
    archive.mkdir(parents=True,exist_ok=False)
    for name in ('protocol.json','events.jsonl','seal.json','final.json'):
        shutil.move(str(STUDY/name),str(archive/name))
    print('Previous study archived read-only by convention:',archive)
    print('The shared registry remains. Now run init with a NEW build and NEW cohort.')

def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='cmd',required=True)
    x=sub.add_parser('init');x.add_argument('--build-id',required=True);x.add_argument('--n',type=int,default=500);
    x.add_argument('--scope',choices=['multi-user','personal-longitudinal'],default='multi-user');x.add_argument('--population',required=True)
    x.add_argument('--retention-days',type=int,default=30)
    y=sub.add_parser('record');y.add_argument('--base',default='http://127.0.0.1:3000');y.add_argument('--participant',required=True);y.add_argument('--build-id',required=True)
    z=sub.add_parser('resolve');z.add_argument('--sid',required=True);z.add_argument('--gold');z.add_argument('--unknown',action='store_true');z.add_argument('--human-checked',action='store_true');z.add_argument('--note')
    z.add_argument('--opened-card');z.add_argument('--not-opened',action='store_true');z.add_argument('--seconds',type=float);z.add_argument('--queries',type=int)
    for cmd in ('progress','seal','certify','next'):sub.add_parser(cmd)
    a=p.parse_args();{'init':init,'record':record,'resolve':resolve,'progress':progress,'seal':seal,'certify':final,'next':next_study}[a.cmd](a)
if __name__=='__main__':main()
