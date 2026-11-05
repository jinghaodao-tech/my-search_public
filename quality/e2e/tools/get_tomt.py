#!/usr/bin/env python3
"""Download and normalize real Reddit-TOMT (Books/Movies) query+item judgments.
All upstream Reddit text stays in local data/. No generated search utterances.
Requires Python 3.10+ stdlib. Run `python tools/get_tomt.py --domain Books`.
"""
import argparse, hashlib, io, json, pathlib, re, sys, urllib.request, zipfile
from collections import defaultdict
BASE='https://raw.githubusercontent.com/samarthbhargav/tomt-data/main/data_release'
FILES={'Books': 'Books.zip','Movies':'Movies.zip'}
ROOT=pathlib.Path(__file__).resolve().parents[1]

def write_jsonl(path, rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',encoding='utf-8') as f:
        for row in rows:f.write(json.dumps(row,ensure_ascii=False)+'\n')

def jsonl(b):
    out=[]
    for line in b.decode('utf-8-sig').splitlines():
        if line.strip():out.append(json.loads(line))
    return out

def adapt_zip(data:bytes, domain:str, outdir:pathlib.Path, source:str):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names=[n for n in z.namelist() if not n.endswith('/')]
        def basename(n):return pathlib.PurePosixPath(n).name.lower()
        docs_files=[n for n in names if basename(n) in ('documents.json','documents.jsonl')]
        query_files=[n for n in names if basename(n) in ('queries.json','queries.jsonl')]
        qrel_files=[n for n in names if basename(n) in ('qrels.txt','qrels.tsv')]
        print('Discovered files:',json.dumps({'docs':docs_files,'queries':query_files,'qrels':qrel_files},ensure_ascii=False))
        if not docs_files or not query_files or not qrel_files:
            raise ValueError('Upstream structure unsupported: need documents.json, queries.json and qrels.txt; inspect ZIP and update adapter, do not fabricate data')
        docs={}
        for f in docs_files:
            for d in jsonl(z.read(f)):
                did=str(d.get('id','')).strip()
                if not did:continue
                docs[did]={'id':domain+':'+did,'title':str(d.get('title') or ''),'body':str(d.get('text') or ''),'source':'Reddit-TOMT:'+domain}
        queries={}
        for f in query_files:
            parts=f.lower().replace('\\','/').split('/')
            orig=next((s for s in ('train','validation','test','dev') if s in parts),None)
            for q in jsonl(z.read(f)):
                qid=str(q.get('id','')).strip()
                if not qid:continue
                title=str(q.get('title') or '')
                desc=str(q.get('description') or q.get('raw_description') or '')
                # CRITICAL: do not use query metadata/replies (answers) as query text.
                phrase=(title+'\n'+desc).strip()
                if not phrase:continue
                row={'id':domain+':'+qid,'query':phrase,'original_split':orig,'source':'reddit-human-recollection'}
                if qid in queries and queries[qid]['query']!=phrase: raise ValueError('Conflicting query id '+qid)
                queries[qid]=row
        qrels=defaultdict(set)
        for f in qrel_files:
            for line in z.read(f).decode('utf-8-sig').splitlines():
                cols=line.strip().split()
                if len(cols)>=4 and cols[3] not in ('0','-1'):
                    qrels[cols[0]].add(cols[2])
        split={'development':[], 'validation':[], 'holdout':[]}
        reasons=defaultdict(int)
        for qid,q in sorted(queries.items()):
            gold=[domain+':'+d for d in qrels.get(qid,set()) if d in docs]
            if not gold:
                reasons['missing_ground_truth_or_doc']+=1;continue
            # Query-grouped split: all questions targeting the same canonical item share the same split.
            # Lexicographically first gold is stable for multi-rel cases; report possible conflicts.
            key=min(gold)
            h=int(hashlib.sha256(('my-search-tomt-split-v1|'+key).encode()).hexdigest()[:12],16)%100
            bucket='development' if h<80 else 'validation' if h<90 else 'holdout'
            split[bucket].append({**q,'gold_ids':sorted(gold),'group_id':key,'split':bucket})
        if not docs or not split['development'] or not split['validation'] or not split['holdout']:
            raise ValueError('Invalid/too small upstream data, cannot form three meaningful splits')
        outdir.mkdir(parents=True,exist_ok=True)
        write_jsonl(outdir/'documents.jsonl',[docs[x] for x in sorted(docs)])
        for k,v in split.items():write_jsonl(outdir/(k+'.jsonl'),v)
        report={'origin':source,'dataset':'Reddit-TOMT','domain':domain,'upstream_zip_sha256':hashlib.sha256(data).hexdigest(),
                'documents':len(docs),'queries_parsed':len(queries),'eligible':sum(map(len,split.values())),
                'split_sizes':{k:len(v) for k,v in split.items()},'unmatched':dict(reasons),
                'rules':'Answer comments/meta excluded from queries; grouping by canonical target item hash; fixed 80/10/10 group hash; not official split.',
                'limitations':'Queries from Reddit and book/movie corpora, not my-search article re-finding; user-generated text rights governed by original publishers.'}
        (outdir/'provenance.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
        print(json.dumps(report,indent=2,ensure_ascii=False));return report

def main():
    p=argparse.ArgumentParser();p.add_argument('--domain',choices=FILES,default='Books');p.add_argument('--out',default=None)
    p.add_argument('--zip',default=None,help='Local upstream zip, e.g. for offline testing');p.add_argument('--download',action='store_true',help='Network download official ZIP');a=p.parse_args()
    out=pathlib.Path(a.out) if a.out else ROOT/'data'/'reddit_tomt'/a.domain.lower()
    if a.zip: b=pathlib.Path(a.zip).read_bytes();origin='local-upstream-zip:'+a.zip
    else:
        url=BASE+'/'+FILES[a.domain]
        print('Downloading:',url)
        req=urllib.request.Request(url,headers={'User-Agent':'my-search-IR-evaluation/1.0'})
        with urllib.request.urlopen(req,timeout=90) as r:b=r.read()
        origin=url
    adapt_zip(b,a.domain,out,origin)
if __name__=='__main__': main()
