#!/usr/bin/env python3
"""Benchmark actual /api/cards on an automatically isolated, temporary SQLite DB.
No requests to the production server. Upstream data must first be downloaded
with get_tomt.py. Python stdlib only, Node/npm dependencies of my-search needed.
"""
import argparse, hashlib, json, math, os, pathlib, re, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error, urllib.parse, unicodedata
from contextlib import nullcontext
from statistics import median
from stats import certify
ROOT=pathlib.Path(__file__).resolve().parents[1]

def read_lines(file):
    if not file.exists():raise FileNotFoundError(str(file)+' missing; run tools/get_tomt.py first')
    # JSON permits Unicode line separators inside strings; split only on JSONL's LF delimiter.
    return [json.loads(line) for line in file.read_text(encoding='utf-8').split('\n') if line.strip()]

def request(base, method, endpoint, payload=None, key=None, timeout=20):
    data=None if payload is None else json.dumps(payload,ensure_ascii=False).encode('utf-8')
    headers={'Content-Type':'application/json'}
    if key:headers['x-api-key']=key
    req=urllib.request.Request(base+endpoint,method=method,data=data,headers=headers)
    with urllib.request.urlopen(req,timeout=timeout) as res:return json.load(res)

def fingerprint(repo):
    try:return subprocess.run(['git','rev-parse','HEAD'],cwd=repo,capture_output=True,text=True,check=True).stdout.strip()
    except Exception:return 'unknown_git_head'

def source_fingerprint(repo):
    try:
        listing=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=repo,capture_output=True,check=True).stdout
        allowed={'.ts','.tsx','.js','.mjs','.css','.html','.json','.yaml','.yml','.sql'}
        excluded=('quality/','node_modules/','dist/','data/','artifacts/','reports/','test-results/','playwright-report/')
        paths=[]
        for raw in listing.split(b'\0'):
            if not raw:continue
            name=raw.decode('utf-8',errors='surrogateescape').replace('\\','/')
            if name.startswith(excluded) or pathlib.PurePosixPath(name).suffix not in allowed or '.env' in name:continue
            path=repo/name
            if path.is_file() and not path.is_symlink():paths.append(name)
        digest=hashlib.sha256()
        for name in sorted(set(paths)):
            data=(repo/name).read_bytes();digest.update(name.encode('utf-8',errors='surrogateescape')+b'\0'+len(data).to_bytes(8,'big')+data)
        return 'sha256:'+digest.hexdigest()
    except Exception:return 'unknown_worktree_fingerprint'

def lexical_tokens(text):
    normalized=unicodedata.normalize('NFKC',text).lower()
    return re.findall(r"[a-z0-9]+(?:['-][a-z0-9]+)*",normalized)

def binary_ndcg_at_10(result):
    if result['status']!='ok':return 0.0
    expected=set(result['expected'])
    ideal=sum(1/math.log2(rank+2) for rank in range(min(10,len(expected))))
    seen=set();dcg=0.0
    for rank,doc_id in enumerate(result['top10'][:10]):
        if doc_id in expected and doc_id not in seen:dcg+=1/math.log2(rank+2)
        seen.add(doc_id)
    return dcg/ideal if ideal else 0.0

def configure_mode(mode, profile):
    mode=dict(mode)
    if profile in ('no-context','stopwords-no-context'):mode['contextBonus']=1
    elif profile in ('no-decay','stopwords-no-decay'):mode['lambda']=0
    elif profile in ('morphology-only','stopwords-morphology-only'):mode['morphologicalWeight']=1;mode['ngramWeight']=0
    elif profile in ('ngram-only','stopwords-ngram-only'):mode['morphologicalWeight']=0;mode['ngramWeight']=1
    elif profile in ('morphology-heavy','stopwords-morphology-heavy'):mode['morphologicalWeight']=0.7;mode['ngramWeight']=0.3
    elif profile in ('ngram-heavy','stopwords-ngram-heavy'):mode['morphologicalWeight']=0.1;mode['ngramWeight']=0.9
    elif profile=='stopwords-low-k1-b0':mode['k1']=0.6;mode['b']=0
    elif profile=='stopwords-classic-bm25':mode['k1']=1.2;mode['b']=0.75
    elif profile=='stopwords-no-context-ngram-heavy':
        mode['contextBonus']=1;mode['morphologicalWeight']=0.1;mode['ngramWeight']=0.9
    return mode

def profile_keywords(keywords, profile, document_frequency, document_count):
    keywords=[dict(item, synonyms=[]) for item in keywords]
    if profile in ('uniform-weights','stopwords-uniform-weights'):
        for keyword in keywords:keyword['weight']=1
    if profile.startswith('stopwords-') or profile=='english-stopwords':
        stopwords={'a','about','after','again','against','all','am','an','and','any','are','as','at','be','because','been','before','being','below','between','both','but','by','could','did','do','does','doing','down','during','each','few','for','from','further','had','has','have','having','he','her','here','hers','herself','him','himself','his','how','i','if','in','into','is','it','its','itself','just','me','more','most','my','myself','no','nor','not','now','of','off','on','once','only','or','other','our','ours','ourselves','out','over','own','same','she','should','so','some','such','than','that','the','their','theirs','them','themselves','then','there','these','they','this','those','through','to','too','under','until','up','very','was','we','were','what','when','where','which','while','who','whom','why','will','with','would','you','your','yours'}
        keywords=[keyword for keyword in keywords if keyword['term'].lower() not in stopwords]
    if profile.startswith('rare-top-') or profile.startswith('stopwords-rare-top-'):
        limit=int(profile.rsplit('-',1)[1])
        ranked=sorted(keywords,key=lambda keyword:(document_frequency.get(lexical_tokens(keyword['term'])[-1] if lexical_tokens(keyword['term']) else '',document_count),keyword['term'].lower()))
        keywords=ranked[:limit]
    return keywords

def run(a):
    repo=pathlib.Path(a.repo).resolve()
    if not (repo/'server.ts').is_file() or not (repo/'package.json').is_file():
        raise ValueError('--repo must be my-search repository root')
    ds=pathlib.Path(a.data).resolve()
    prov=json.loads((ds/'provenance.json').read_text(encoding='utf-8'))
    docs=read_lines(ds/'documents.jsonl');queries=read_lines(ds/(a.stage+'.jsonl'))
    if a.sample_manifest:
        sample=json.loads(pathlib.Path(a.sample_manifest).read_text(encoding='utf-8'))
        if sample.get('stage')!=a.stage:raise ValueError('Sample manifest stage does not match benchmark stage')
        selected=set(sample.get('group_ids',[]));expected_qids=set(sample.get('query_ids',[]))
        queries=[q for q in queries if q['group_id'] in selected]
        if {q['id'] for q in queries}!=expected_qids:raise ValueError('Sample manifest query/group IDs do not match dataset')
    elif a.group_limit:
        by_group={q['group_id'] for q in queries}
        selected=set(sorted(by_group,key=lambda group:hashlib.sha256((a.group_seed+'|'+group).encode('utf-8')).hexdigest())[:a.group_limit])
        queries=[q for q in queries if q['group_id'] in selected]
    if a.max_queries:queries=queries[:a.max_queries]
    if not docs or not queries:raise ValueError('dataset empty')
    diagnostic=bool(a.max_queries or a.group_limit or a.sample_manifest or a.diagnostics)
    if a.diagnostics and a.stage not in ('development','validation'):
        raise ValueError('--diagnostics is limited to development/validation; do not inspect holdout data')
    out=pathlib.Path(a.out).resolve()
    out.parent.mkdir(parents=True,exist_ok=True)
    if a.stage=='holdout':
        if not a.final or diagnostic or a.group_limit or a.sample_manifest:raise ValueError('Holdout is sealed: require --final, no query/group subset')
        ledger=ROOT/'local'/('holdout_consumed_'+prov['domain'].lower()+'_'+prov['upstream_zip_sha256'][:12]+'.json')
        if ledger.exists():raise ValueError('This corpus holdout already consumed in this kit at '+str(ledger))
    tmp_context = nullcontext(str(pathlib.Path(a.reuse_db).resolve().parent)) if a.reuse_db else tempfile.TemporaryDirectory(prefix='mysearch_tomt_isolated_')
    with tmp_context as tmp:
        env=dict(os.environ);env.update({'DB_PATH':str(pathlib.Path(a.reuse_db).resolve()) if a.reuse_db else str(pathlib.Path(tmp)/'benchmark.db'), 'HOST':'127.0.0.1','SITE_SYNC':'off','NODE_ENV':'benchmark','DEMO_MODE':'0','IMPORT_RATE_LIMIT':'1000'})
        memory_path=out.with_name(out.name+'.memory.jsonl')
        if a.reuse_db:
            mapping_path=pathlib.Path(a.reuse_db).resolve().with_name('mapping.json')
            if not mapping_path.is_file():raise FileNotFoundError('Reuse DB mapping missing: '+str(mapping_path))
            mapping=json.loads(mapping_path.read_text(encoding='utf-8'))
            if len(mapping)!=len(docs):raise RuntimeError('Reuse DB corpus size does not match the selected dataset')
        else:
            input_path=pathlib.Path(tmp)/'corpus.json';mapping_path=pathlib.Path(tmp)/'mapping.json'
            input_path.write_text(json.dumps(docs,ensure_ascii=False),encoding='utf-8')
            seed_command=[os.environ.get('NODE_BINARY','node'),'--import','tsx',
                          str(ROOT/'tools'/'seed_corpus.ts'),str(input_path),str(mapping_path)]
            seeded=subprocess.run(seed_command,cwd=repo,env=env,capture_output=True,text=True,timeout=1800)
            if seeded.returncode:raise RuntimeError('Isolated corpus seeding failed: '+seeded.stderr[-4000:])
            print(seeded.stdout.strip(),flush=True)
            mapping=json.loads(mapping_path.read_text(encoding='utf-8'))
            if len(mapping)!=len(docs):raise RuntimeError('Corpus import invalid (no measurement): imported '+str(len(mapping))+' of '+str(len(docs)))
        with socket.socket() as sk:sk.bind(('127.0.0.1',0));port=sk.getsockname()[1]
        env['PORT']=str(port)
        if a.measure_memory:
            env['MY_SEARCH_BENCHMARK_MEMORY_LOG']=str(memory_path)
            probe=(ROOT/'tools'/'memory_probe.cjs').resolve().as_posix()
            env['NODE_OPTIONS']=(env.get('NODE_OPTIONS','')+' --require='+probe).strip()
        base='http://127.0.0.1:'+str(port)
        # Avoid local .env-injected API credentials where possible; the search app may require them anyway.
        logfile=open(pathlib.Path(tmp)/'server.log','w',encoding='utf-8')
        # Windows installs npm as a .cmd shim, which CreateProcess cannot launch directly.
        command = ([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/s', '/c', 'npm start']
                   if os.name == 'nt' else ['npm', 'start'])
        proc=subprocess.Popen(command,cwd=repo,env=env,stdout=logfile,stderr=subprocess.STDOUT)
        try:
            ready=False
            startup_attempts=max(1, round(a.startup_timeout_seconds / 0.35))
            for attempt in range(startup_attempts):
                if proc.poll() is not None:break
                try:
                    request(base,'GET','/healthz',timeout=1)
                    ready=True;break
                except Exception:time.sleep(.35)
                if (attempt + 1) % 60 == 0:
                    print('Waiting for isolated server startup:', round((attempt + 1) * .35), 'seconds', flush=True)
            if not ready:
                logfile.flush();raise RuntimeError('isolated server failed to start within '+str(a.startup_timeout_seconds)+' seconds; log: '+(pathlib.Path(tmp)/'server.log').read_text(encoding='utf-8')[-4000:])
            source_id_by_card_id={card_id:source_id for source_id,card_id in mapping.items()}
            profiles=a.compare_profiles or [a.profile]
            document_frequency={}
            if any(profile.startswith('rare-top-') or profile.startswith('stopwords-rare-top-') for profile in profiles):
                for doc in docs:
                    for token in set(lexical_tokens((doc.get('title') or '')+' '+(doc.get('body') or ''))):
                        document_frequency[token]=document_frequency.get(token,0)+1
            modes=request(base,'GET','/api/modes',key=a.api_key)
            if not isinstance(modes,dict) or not modes:raise RuntimeError('No default search mode available')
            selected_mode_id=a.mode_id or next(iter(modes))
            if selected_mode_id not in modes:raise ValueError('Unknown --mode-id: '+selected_mode_id)
            base_mode=modes[selected_mode_id]
            configured_modes={profile:configure_mode(base_mode,profile) for profile in profiles}
            if a.stage=='holdout':
                ledger.parent.mkdir(exist_ok=True,parents=True)
                with ledger.open('x',encoding='utf-8') as f:
                    json.dump({'stage':'holdout','started_at':time.time(),'repo':str(repo),
                               'corpus_sha256':prov['upstream_zip_sha256'],'build_git_head':fingerprint(repo)},f,indent=2)
            results_by_profile={};latencies={}
            for profile in profiles:
                mode=configured_modes[profile];results=[];lat=[]
                for i,q in enumerate(queries,1):
                    expected=[mapping[x] for x in q['gold_ids'] if x in mapping]
                    status='ok';ids=[];keyword_terms=[]
                    t0=time.perf_counter()
                    try:
                        analysis=request(base,'POST','/api/search/terms',{'text':q['query']},key=a.api_key)
                        keyword_terms=[item['term'] for item in analysis['keywords']]
                        config={'label':'検索','description':mode.get('description',''),'k1':mode['k1'],'b':mode['b'],
                                'lambda':mode['lambda'],'contextBonus':mode['contextBonus'],
                                'keywords':profile_keywords(analysis['keywords'],profile,document_frequency,len(docs))}
                        if profile in ('morphology-only','ngram-only','morphology-heavy','ngram-heavy',
                                        'stopwords-morphology-heavy','stopwords-ngram-only','stopwords-morphology-only',
                                        'stopwords-ngram-heavy','stopwords-no-context-ngram-heavy'):
                            config['morphologicalWeight']=mode['morphologicalWeight']
                            config['ngramWeight']=mode['ngramWeight']
                        response=request(base,'POST','/api/cards/search',{
                            'config':config,
                            'options':{'dedupThreshold':a.dedup_threshold,'archiveScoreThreshold':0 if a.diagnostics or profile=='no-archive' else 0.5,
                                       'resultLimit':a.diagnostic_limit if a.diagnostics else 50},
                            'filters':{'excludedTerms':[],'sources':[],'status':'all'},
                        },key=a.api_key)
                        active=response.get('active')
                        if not isinstance(active,list):status='invalid_response'
                        else:ids=[x.get('article',{}).get('id') for x in active[:10]]
                    except Exception as e:status='request_error:'+str(e)[:160]
                    dt=1000*(time.perf_counter()-t0);lat.append(dt)
                    rank=next((r+1 for r,x in enumerate(ids) if x in expected),None)
                    result={'qid':q['id'],'group_id':q['group_id'],'expected':q['gold_ids'],'rank':rank,
                        'top10':[source_id_by_card_id.get(card_id,card_id) for card_id in ids],
                        'query':q['query'],'keyword_terms':keyword_terms,
                        'success':bool(rank and rank<=10 and status=='ok'),'status':status,'latency_ms':round(dt,1)}
                    if a.diagnostics and status=='ok' and isinstance(active,list):
                        ranked=active
                        expected_set=set(expected)
                        target=next((item for item in ranked if item.get('article',{}).get('id') in expected_set),None)
                        target_rank=next((idx+1 for idx,item in enumerate(ranked)
                                          if item.get('article',{}).get('id') in expected_set),None)
                        candidate_count=response.get('stats',{}).get('activeCount')
                        rank_1000=(target_rank if target_rank else
                                   ('not_generated' if isinstance(candidate_count,int) and candidate_count<=a.diagnostic_limit else 'not_observable_after_api_limit'))
                        result.update({
                            'diagnostic_rank':target_rank,
                            'diagnostic_rank_at_100':target_rank if target_rank and target_rank<=100 else None,
                            'diagnostic_rank_at_500':target_rank if target_rank and target_rank<=500 else None,
                            'diagnostic_rank_at_1000':rank_1000,
                            'scored_candidate_count':candidate_count,
                            'archive_candidate_count':response.get('stats',{}).get('archivedCount'),
                            'target_score':target.get('score') if target else None,
                            'target_breakdown':target.get('breakdown') if target else None,
                            'diagnostic_top500':[{
                                'id':source_id_by_card_id.get(item.get('article',{}).get('id'),item.get('article',{}).get('id')),
                                'score':item.get('score'),
                                'breakdown':item.get('breakdown'),
                            } for item in ranked[:a.diagnostic_limit]],
                        })
                    results.append(result)
                    if i%500==0:print('Evaluated',profile,i,'/',len(queries),flush=True)
                k=sum(r['success'] for r in results);latencies[profile]=lat
                results_by_profile[profile]={'stats':certify(k,len(queries)),'hit_at_1':sum(r['rank']==1 for r in results)/len(results),
                    'mrr_at_10':sum(1/r['rank'] for r in results if r['success'])/len(results),
                    'binary_ndcg_at_10':sum(binary_ndcg_at_10(r) for r in results)/len(results),
                    'latency_ms_median':round(median(lat),1),'latency_ms_p95':round(sorted(lat)[min(len(lat)-1,int(.95*len(lat)))],1),
                    'failures':[r for r in results if not r['success']][:100],'all_results':results}
            report={'stage':a.stage,'dataset':prov['dataset'],'domain':prov['domain'],'source_sha256':prov['upstream_zip_sha256'],
                    'mode_id':selected_mode_id,
                    'build_git_head':fingerprint(repo),'build_source_fingerprint':source_fingerprint(repo),
                    'isolation':('preseeded isolated SQLite DB; corpus tokenized and stored through app repository code; search via API on 127.0.0.1 random port'
                                 if a.reuse_db else 'new tempfile SQLite DB; corpus tokenized and stored through app repository code; search via API on 127.0.0.1 random port'),
                    'method':'UI-equivalent saved-card search: POST /api/search/terms then POST /api/cards/search; explicit mode_id recorded above',
                    'effective_modes':configured_modes,
                    'search_options_by_profile':{
                        profile:{'deduplicationEnabled':a.dedup_threshold < 1,
                                 'dedupThreshold':a.dedup_threshold,
                                 'archiveScoreThreshold':0 if a.diagnostics or profile=='no-archive' else 0.5,
                                 'resultLimit':a.diagnostic_limit if a.diagnostics else 50}
                        for profile in profiles},
                    'api_process_memory':None,
                    'profiles':results_by_profile if len(profiles)>1 else None,
                    'profile':profiles[0] if len(profiles)==1 else None,
                    'diagnostic_only':diagnostic,
                    'result_interpretation':('Dataset domain: '+str(prov['domain'])+'; this benchmark does not establish product-wide natural-user article refinding')}
            if a.measure_memory:
                samples=[json.loads(line) for line in memory_path.read_text(encoding='utf-8').splitlines() if line.strip()] if memory_path.exists() else []
                report['api_process_memory']={
                    'measurement':'one-second RSS/heap samples from the isolated API server process; sampled peak, not whole benchmark process',
                    'samples':len(samples),
                    'sampled_peak_rss_bytes':max((item['rssBytes'] for item in samples),default=None),
                    'sampled_peak_heap_used_bytes':max((item['heapUsedBytes'] for item in samples),default=None),
                    'sampled_peak_heap_total_bytes':max((item['heapTotalBytes'] for item in samples),default=None),
                    'sampled_peak_external_bytes':max((item['externalBytes'] for item in samples),default=None),
                    'sample_file':str(memory_path),
                }
            if len(profiles)==1:report.update(results_by_profile[profiles[0]])
            out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            compact={**report}
            if compact.get('profiles'):
                compact['profiles']={name:{k:v for k,v in values.items() if k not in ('failures','all_results')} for name,values in compact['profiles'].items()}
            for key in ('failures','all_results'):compact.pop(key,None)
            print(json.dumps(compact,ensure_ascii=False,indent=2))
            return report
        finally:
            if os.name == 'nt' and proc.poll() is None:
                subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            elif proc.poll() is None:
                proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()
            logfile.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--data',default=str(ROOT/'data/reddit_tomt/books'))
    p.add_argument('--stage',choices=['development','validation','holdout'],default='development')
    p.add_argument('--out',default=str(ROOT/'artifacts/benchmark_dev.json'));p.add_argument('--api-key',default=os.environ.get('API_KEY'))
    p.add_argument('--max-queries',type=int,default=0);p.add_argument('--final',action='store_true')
    p.add_argument('--group-limit',type=int,default=0,help='Deterministically select this many whole query groups')
    p.add_argument('--group-seed',default='my-search-tomt-group-sample-v1')
    p.add_argument('--sample-manifest',default=None,help='Use a previously saved fixed group/query sample')
    p.add_argument('--mode-id',default=None,help='Select an explicit application search mode; default is the first configured mode')
    p.add_argument('--reuse-db',default=None,help='Use an existing isolated benchmark DB and sibling mapping.json')
    p.add_argument('--startup-timeout-seconds',type=int,default=300,help='Maximum wait for an isolated API startup, including one-time token backfills')
    p.add_argument('--measure-memory',action='store_true',help='Sample isolated Node API RSS and heap once per second')
    p.add_argument('--dedup-threshold',type=float,default=0.8,help='Dedup threshold; 1 disables deduplication (0 does not)')
    p.add_argument('--diagnostics',action='store_true',help='Capture parser terms, target rank and score breakdown in a development/validation diagnostic run')
    p.add_argument('--diagnostic-limit',type=int,choices=[100,500],default=500,help='Top-N diagnostic result window; the app API currently caps results at 500')
    p.add_argument('--compare-profiles',nargs='+',choices=['current','no-archive','no-context','no-decay','uniform-weights','english-stopwords',
        'rare-top-4','rare-top-6','rare-top-8','rare-top-12','rare-top-16','rare-top-24','rare-top-32',
        'stopwords-rare-top-24','morphology-only','ngram-only','morphology-heavy','ngram-heavy',
        'stopwords-morphology-heavy','stopwords-ngram-only','stopwords-morphology-only','stopwords-ngram-heavy',
        'stopwords-no-context','stopwords-no-decay','stopwords-no-context-ngram-heavy','stopwords-uniform-weights',
        'stopwords-classic-bm25','stopwords-low-k1-b0'])
    p.add_argument('--profile',choices=['current','no-archive','no-context','no-decay','uniform-weights','english-stopwords',
        'rare-top-4','rare-top-6','rare-top-8','rare-top-12','rare-top-16','rare-top-24','rare-top-32',
        'stopwords-rare-top-24','morphology-only','ngram-only','morphology-heavy','ngram-heavy',
        'stopwords-morphology-heavy','stopwords-ngram-only','stopwords-morphology-only','stopwords-ngram-heavy',
        'stopwords-no-context','stopwords-no-decay','stopwords-no-context-ngram-heavy','stopwords-uniform-weights',
        'stopwords-classic-bm25','stopwords-low-k1-b0'],default='current')
    a=p.parse_args();run(a)
