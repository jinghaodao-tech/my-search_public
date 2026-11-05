#!/usr/bin/env python3
"""Collect public *metadata* from official Qiita API and official Zenn RSS only.
No HTML page scraping. No bulk distribution of third-party article bodies.
"""
import argparse, datetime as dt, hashlib, html, json, os, pathlib, re, sys, time
import urllib.error, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from html.parser import HTMLParser

TOPICS = ['typescript','python','react','nextjs','javascript','nodejs','golang','rust',
          'docker','kubernetes','aws','gcp','azure','linux','postgresql','mysql',
          'sqlite','security','machinelearning','ai','llm','devops','terraform',
          'git','github','testing','algorithm','database','frontend','backend']
QIITA_TAGS = ['TypeScript','Python','React','Next.js','JavaScript','Node.js','Go',
              'Rust','Docker','Kubernetes','AWS','GCP','Linux','PostgreSQL','MySQL',
              'SQLite','セキュリティ','機械学習','AI','LLM','GitHub','Terraform',
              'アルゴリズム','データベース']

class Cleaner(HTMLParser):
    def __init__(self): super().__init__(); self.parts=[]
    def handle_data(self,data): self.parts.append(data)
def clean(s):
    c=Cleaner()
    try: c.feed(str(s or ''))
    except Exception: return ''
    return re.sub(r'\s+',' ',html.unescape(' '.join(c.parts))).strip()
def canonical(url):
    u=urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((u.scheme.lower(),u.netloc.lower(),u.path.rstrip('/'),'','',''))
def get(url, token=None):
    h={'User-Agent':'my-search-evaluation-dataset/1.0 (read-only; research)',
       'Accept':'application/json, application/atom+xml, application/rss+xml, application/xml, text/xml'}
    if token: h['Authorization']='Bearer '+token
    with urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=25) as resp:
        return resp.read(),dict(resp.headers)
def record(source,title,url,author='',tags=None,published='',summary='',body=None):
    title=clean(title)
    if not title or not url or not url.startswith('https://'): return None
    id='doc_'+hashlib.sha256(canonical(url).encode()).hexdigest()[:20]
    item={'id':id,'source':source,'url':canonical(url),'title':title,'author':author,
          'tags':list(dict.fromkeys(tags or [])), 'published_at':published,
          'summary':clean(summary)[:600], 'body_included':body is not None,
          'retrieval_method':'official_qiita_api' if source=='qiita' else 'official_zenn_rss',
          'retrieved_at_utc':dt.datetime.now(dt.timezone.utc).isoformat()}
    if body is not None: item['body']=body
    return item

def qiita_page(tag,page,token=None,body_allowed=False):
    url='https://qiita.com/api/v2/items?'+urllib.parse.urlencode({'page':page,'per_page':100,'query':'tag:'+tag})
    data,headers=get(url,token)
    posts=json.loads(data)
    if not isinstance(posts,list): raise ValueError('Qiita response is not a list')
    out=[]
    for x in posts:
        u=x.get('url','')
        if not u.startswith('https://qiita.com/') or x.get('private',False): continue
        body=x.get('body','') if body_allowed else None
        # For permitted local full-text benchmarking, opt in explicitly. Never redistribute bodies.
        a=record('qiita',x.get('title'),u,(x.get('user') or {}).get('id',''),
                 [t.get('name','') for t in x.get('tags',[]) if isinstance(t,dict)],
                 x.get('created_at',''),'',body)
        if a: out.append(a)
    remaining=headers.get('RateLimit-Remaining', headers.get('ratelimit-remaining',headers.get('X-RateLimit-Remaining','')))
    return out, remaining

def text_of(el,names):
    for name in names:
        sub=el.find(name)
        if sub is not None and sub.text: return sub.text.strip()
    return ''
def zenn_feed(topic):
    url='https://zenn.dev/feed' if topic=='_trending' else f'https://zenn.dev/topics/{urllib.parse.quote(topic)}/feed'
    payload,_=get(url)
    root=ET.fromstring(payload)
    ns={'a':'http://www.w3.org/2005/Atom'}
    entries=root.findall('.//item') or root.findall('a:entry',ns)
    out=[]
    for e in entries:
        link=text_of(e,['link','{http://www.w3.org/2005/Atom}link'])
        if not link:
            l=e.find('{http://www.w3.org/2005/Atom}link')
            if l is not None: link=l.get('href','')
        if not link or '/articles/' not in link: continue
        title=text_of(e,['title','{http://www.w3.org/2005/Atom}title'])
        summary=text_of(e,['description','{http://www.w3.org/2005/Atom}summary'])
        published=text_of(e,['pubDate','{http://www.w3.org/2005/Atom}published'])
        author=text_of(e,['{http://purl.org/dc/elements/1.1/}creator'])
        a=record('zenn',title,link,author,[topic] if topic!='_trending' else [],published,summary)
        if a:out.append(a)
    return out

def save(outdir, items, source_events, target, minimum, audit_similarity=True):
    outdir.mkdir(parents=True,exist_ok=True)
    # Stable random selection, avoiding order / source recency bias. Note: still convenience-sampled topics.
    chosen=sorted(items.values(),key=lambda x:hashlib.sha256(('ms-articles-v1|'+x['id']).encode()).hexdigest())[:target]
    p=outdir/'articles.jsonl'; tmp=outdir/'articles.jsonl.tmp'
    with tmp.open('w',encoding='utf-8') as f:
        for x in chosen: f.write(json.dumps(x,ensure_ascii=False)+'\n')
    tmp.replace(p)
    by_source={s:sum(x['source']==s for x in chosen) for s in ['qiita','zenn']}
    by_topic={}; authors={}; normalized_titles={}
    for x in chosen:
        for tag in x.get('tags',[]): by_topic[tag]=by_topic.get(tag,0)+1
        author=(x.get('author') or '').strip()
        if author: authors[author]=authors.get(author,0)+1
        title=re.sub(r'[^\w\u3040-\u30ff\u3400-\u9fff]+','',x['title'].casefold())
        normalized_titles.setdefault(title,[]).append(x['id'])
    exact_title_groups=[ids for ids in normalized_titles.values() if len(ids)>1]
    duplicate_rows=[]
    by_id={x['id']:x for x in chosen}
    for title,ids in normalized_titles.items():
        if len(ids)>1:
            duplicate_rows.append({'normalized_title':title,'articles':[{
                'id':by_id[i]['id'],'source':by_id[i]['source'],'author':by_id[i]['author'],
                'published_at':by_id[i]['published_at'],'url':by_id[i]['url']} for i in ids]})
    (outdir/'exact_title_review_candidates.json').write_text(
        json.dumps({'rule':'NFKC/casefold title with punctuation removed',
                    'automatic_content_identity_claim':False,'groups':duplicate_rows},
                   indent=2,ensure_ascii=False),encoding='utf-8')
    # Short metadata cannot justify automatic removal; emit candidate pairs for review only.
    def shingles(text):
        text=re.sub(r'\s+','',text.casefold())
        return {text[i:i+3] for i in range(len(text)-2)} if len(text)>=3 else ({text} if text else set())
    review_file=outdir/'similarity_review_candidates.json'
    if audit_similarity:
        prepared=[(x,shingles(x['title']+' '+x.get('summary',''))) for x in chosen]
        review_candidates=[]
        for i,(left,left_tokens) in enumerate(prepared):
            if not left_tokens: continue
            for right,right_tokens in prepared[i+1:]:
                if left['url']==right['url'] or not right_tokens: continue
                similarity=len(left_tokens & right_tokens)/len(left_tokens | right_tokens)
                if similarity>=0.9:
                    review_candidates.append({'left_id':left['id'],'right_id':right['id'],
                        'similarity_jaccard_char3':round(similarity,4),
                        'left_url':left['url'],'right_url':right['url']})
        review_candidates.sort(key=lambda x:(-x['similarity_jaccard_char3'],x['left_id'],x['right_id']))
        review_file.write_text(json.dumps({'method':'Jaccard of character trigrams over title + metadata summary',
                    'threshold':0.9,'automatic_removal':False,'pairs':review_candidates},
                   indent=2,ensure_ascii=False),encoding='utf-8')
    elif review_file.exists():
        review_candidates=json.loads(review_file.read_text(encoding='utf-8')).get('pairs',[])
    else:
        review_candidates=[]
    # Exact normalized title duplicates are conservatively collapsed only in a derived corpus.
    title_unique=[]
    for ids in normalized_titles.values():
        title_unique.append(by_id[sorted(ids)[0]])
    title_unique.sort(key=lambda x:x['id'])
    unique_path=outdir/'articles_unique_titles.jsonl'
    unique_path.write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in title_unique),encoding='utf-8')
    manifest={'created_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),
              'target':target,'minimum':minimum,'eligible_unique_urls':len(items),'selected_url_unique':len(chosen),
              'exact_title_deduplicated_count':len(title_unique),
              'status':'READY_CORPUS_ONLY' if len(title_unique)>=minimum else 'INSUFFICIENT_AFTER_TITLE_DEDUP',
              'source_counts':by_source,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
              'topic_counts':dict(sorted(by_topic.items(),key=lambda x:(-x[1],x[0]))),
              'distinct_nonempty_authors':len(authors),
              'top_10_author_counts':dict(sorted(authors.items(),key=lambda x:(-x[1],x[0]))[:10]),
              'max_single_author_share':round(max(authors.values(),default=0)/len(chosen),4) if chosen else 0,
              'exact_normalized_title_duplicate_groups':len(exact_title_groups),
              'near_duplicate_review_pair_count':len(review_candidates),
              'full_body_count':sum(bool(x['body_included']) for x in chosen),
              'usage_scope':'Local private evaluation; do not redistribute authors\' content',
              'collection_is_not_representative_sample':True,
              'source_events':source_events}
    (outdir/'manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf-8')
    return manifest

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--output',default='local_article_corpus')
    p.add_argument('--target',type=int,default=2500)
    p.add_argument('--minimum',type=int,default=2000)
    p.add_argument('--qiita-pages',type=int,default=2)
    p.add_argument('--max-qiita-requests',type=int,default=48)
    p.add_argument('--delay',type=float,default=1.3)
    p.add_argument('--qiita-only',action='store_true')
    p.add_argument('--zenn-only',action='store_true')
    p.add_argument('--include-qiita-body',action='store_true',help='Explicit opt-in ONLY after validating your permitted local use; never share bodies')
    args=p.parse_args()
    if args.target<args.minimum or args.minimum<1: p.error('target must be >= minimum >= 1')
    if args.include_qiita_body:
        print('WARNING: full-text local copies may need legal/terms review. Never distribute this dataset.',file=sys.stderr)
    out=pathlib.Path(args.output); out.mkdir(parents=True,exist_ok=True)
    existing=out/'articles.jsonl'; items={}; events=[]
    previous_manifest=out/'manifest.json'
    if previous_manifest.exists():
        try: events=json.loads(previous_manifest.read_text(encoding='utf-8')).get('source_events',[])
        except (ValueError,OSError): events=[]
    if existing.exists():
        for line in existing.read_text(encoding='utf-8').splitlines():
            if line.strip():
                x=json.loads(line); items[x['id']]=x
    def add(xs):
        for x in xs:
            old=items.get(x['id'])
            if old is None: items[x['id']]=x
            else:
                old['tags']=sorted(set(old.get('tags',[])+x.get('tags',[])))
                if not old.get('summary') and x.get('summary'):old['summary']=x['summary']
                if x.get('body_included') and not old.get('body_included'):items[x['id']]=x
    if not args.qiita_only:
        for topic in ['_trending']+TOPICS:
            try:
                result=zenn_feed(topic); add(result); events.append({'feed':'zenn:'+topic,'status':'ok','count':len(result)})
                print('Zenn',topic,'found',len(result),'unique',len(items),flush=True)
            except Exception as e:
                events.append({'feed':'zenn:'+topic,'status':'error','message':str(e)[:120]})
            time.sleep(max(0,args.delay))
    if not args.zenn_only:
        count=0; token=os.getenv('QIITA_TOKEN')
        for tag in QIITA_TAGS:
            for page in range(1,args.qiita_pages+1):
                if count>=args.max_qiita_requests:break
                count+=1
                try:
                    result,remain=qiita_page(tag,page,token,args.include_qiita_body)
                    add(result); events.append({'feed':'qiita:'+tag+':'+str(page),'status':'ok','count':len(result),'remaining':remain})
                    print('Qiita',tag,'page',page,'found',len(result),'unique',len(items),'remain',remain,flush=True)
                    if remain.isdecimal() and int(remain)<2:break
                except urllib.error.HTTPError as e:
                    events.append({'feed':'qiita:'+tag+':'+str(page),'status':'http_error','code':e.code})
                    if e.code in (403,429):
                        print('Qiita quota/rate limit reached; stopping',file=sys.stderr)
                        break
                except Exception as e:events.append({'feed':'qiita:'+tag+':'+str(page),'status':'error','message':str(e)[:120]})
                finally:
                    save(out,items,events,args.target,args.minimum,audit_similarity=False)
                    time.sleep(max(0,args.delay))
            if events and events[-1].get('code') in (403,429):break
    manifest=save(out,items,events,args.target,args.minimum,audit_similarity=True)
    print(json.dumps({k:manifest[k] for k in ['status','selected_url_unique','eligible_unique_urls',
        'exact_title_deduplicated_count','source_counts','sha256']},ensure_ascii=False,indent=2))
    if manifest['status']!='READY_CORPUS_ONLY': sys.exit(2)

if __name__=='__main__':main()
