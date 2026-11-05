#!/usr/bin/env python3
"""Fetch independently sourced Japanese retrieval datasets and standardize them.

Outputs: corpus.jsonl, queries.jsonl, qrels.tsv, splits.jsonl, manifest.json
Always use a fresh output directory for new datasets. This does not touch my-search DB.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

SALT = 'my-search-ja-retrieval-split-v1|'

def jdump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def write_lines(path: Path, records):
    with path.open('w', encoding='utf-8', newline='\n') as file:
        for record in records:
            file.write(jdump(record) + '\n')

def text_or_blank(item, *keys):
    for key in keys:
        if key in item and item[key] is not None:
            return str(item[key])
    return ''

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1<<20), b''):
            h.update(block)
    return h.hexdigest()

def norm_jagov(data):
    corpus, queries, qrels = (data['corpus'], data['queries'], data['qrels'])
    documents = []
    for x in corpus:
        did = text_or_blank(x, '_id', 'id', 'docid')
        value = text_or_blank(x, 'text', 'content', 'body')
        if not did or not value.strip(): raise ValueError(f'Invalid corpus row: {x}')
        documents.append({'id': did, 'title':text_or_blank(x, 'title'), 'text': value})
    questions = []
    for x in queries:
        qid = text_or_blank(x, '_id', 'id', 'query_id', 'query-id')
        q = text_or_blank(x, 'text', 'query', 'question')
        if not qid or not q.strip(): raise ValueError(f'Invalid query row: {x}')
        questions.append({'id': qid, 'query': q})
    relevance = []
    for x in qrels:
        qid = text_or_blank(x, 'query-id', 'query_id', 'qid', 'queryid')
        did = text_or_blank(x, 'corpus-id', 'corpus_id', 'docid', 'document_id', 'doc_id')
        grade = x.get('score', x.get('relevance', x.get('rel', 1)))
        if not qid or not did: raise ValueError(f'Unknown qrel schema: {x}')
        relevance.append({'query_id': qid, 'doc_id': did, 'relevance':int(grade)})
    return documents,questions,relevance

def make_fixture():
    docs=[{'_id':'d1','title':'','text':'この文書にはSQLiteの索引について説明がある。'},
          {'_id':'d2','title':'','text':'別文書にはネットワークについて説明がある。'}]
    queries=[{'_id':'q1','text':'SQLiteの索引とは？'}, {'_id':'q2','text':'ネットワークについて知りたい'}]
    qrels=[{'query-id':'q1','corpus-id':'d1','score':1},{'query-id':'q2','corpus-id':'d2','score':1}]
    return norm_jagov({'corpus':docs,'queries':queries,'qrels':qrels})

def load_jagov():
    from datasets import load_dataset
    from huggingface_hub import HfApi
    repo = 'mteb/JaGovFaqsRetrieval'
    revision = HfApi().dataset_info(repo).sha
    arrays={}
    for config in ('corpus','queries','qrels'):
        # Prefer public parquet with explicit config; no external executable script is trusted.
        arrays[config] = [dict(x) for x in load_dataset(repo, name=config, split='test', revision=revision)]
    return (*norm_jagov(arrays), revision)

def load_miracl_ja(output):
    from huggingface_hub import hf_hub_download, HfApi
    origin='miracl/miracl'
    revision=HfApi().dataset_info(origin).sha
    all_queries,all_rel=[],[]
    for part in ('train','dev'):
        t=hf_hub_download(repo_id=origin, repo_type='dataset', revision=revision, filename=f'miracl-v1.0-ja/topics/topics.miracl-v1.0-ja-{part}.tsv')
        q=hf_hub_download(repo_id=origin, repo_type='dataset', revision=revision, filename=f'miracl-v1.0-ja/qrels/qrels.miracl-v1.0-ja-{part}.tsv')
        with open(t,encoding='utf-8') as f:
            for line in f:
                s=line.rstrip('\r\n').split('\t', 1)
                if len(s)!=2: raise ValueError('Unexpected MIRACL topics format')
                all_queries.append({'id':f'{part}:{s[0]}','query':s[1], 'original_split':part})
        with open(q,encoding='utf-8') as f:
            for line in f:
                cols=line.split()
                if len(cols)!=4:raise ValueError('Unexpected MIRACL qrels format')
                all_rel.append({'query_id':f'{part}:{cols[0]}','doc_id':cols[2], 'relevance':int(cols[3])})
    # Official Japanese corpus contains millions of passages. This command intentionally does
    # not fake a full-corpus evaluation by searching only gold positives.
    documents=[]
    return documents, all_queries, all_rel, revision

def prepare(documents, queries, rels, out:Path, source:str, allow_missing_corpus=False, source_revision=None):
    out.mkdir(parents=True,exist_ok=True)
    docs = sorted(documents,key=lambda x:x['id'])
    qs = sorted(queries,key=lambda x:x['id'])
    rels = sorted(rels,key=lambda x:(x['query_id'],x['doc_id']))
    dids={d['id'] for d in docs}; qids={q['id'] for q in qs}
    if len(dids)!=len(docs) or len(qids)!=len(qs): raise ValueError('Duplicate IDs')
    byq=defaultdict(list)
    for r in rels:
        if r['query_id'] not in qids:raise ValueError('Qrel query not in queries')
        if not allow_missing_corpus and r['doc_id'] not in dids:raise ValueError('Qrel doc not in corpus')
        if r['relevance']>0:byq[r['query_id']].append(r['doc_id'])
    missing=[q['id'] for q in qs if not byq[q['id']]]
    if missing:raise ValueError(f'Queries without positive qrels: {missing[:4]} ({len(missing)} total)')
    # Keep questions connected whenever they share any positive document.
    # Choosing only one positive ID per query can leak shared targets across splits.
    parent = {qid: qid for qid in byq}
    def find(qid):
        while parent[qid] != qid:
            parent[qid] = parent[parent[qid]]
            qid = parent[qid]
        return qid
    owner = {}
    for qid, doc_ids in byq.items():
        root = find(qid)
        for did in set(doc_ids):
            if did in owner:
                other = find(owner[did])
                root = find(root)
                if root != other:
                    parent[root] = other
                    root = other
            else:
                owner[did] = qid
    group = {qid: find(qid) for qid in byq}
    gids=sorted(set(group.values()), key=lambda gid:hashlib.sha256((SALT+gid).encode('utf-8')).hexdigest())
    n=len(gids)
    cut1=int(n*.30);cut2=int(n*.50)
    group_split={g:('development' if i<cut1 else 'validation' if i<cut2 else 'holdout') for i,g in enumerate(gids)}
    split=[{'id':q['id'],'group_id':group[q['id']],'split':group_split[group[q['id']]]} for q in qs]
    write_lines(out/'corpus.jsonl',docs)
    write_lines(out/'queries.jsonl',qs)
    write_lines(out/'splits.jsonl',split)
    with (out/'qrels.tsv').open('w',encoding='utf-8',newline='\n') as f:
        for r in rels:
            f.write(f"{r['query_id']}\t0\t{r['doc_id']}\t{r['relevance']}\n")
    manifest={
        'dataset':source,
        'source_revision':source_revision,
        'created_utc':datetime.now(timezone.utc).isoformat(),
        'document_count':len(docs),'query_count':len(qs),'qrel_count':len(rels),
        'split_counts':dict(Counter(x['split'] for x in split)),
        'split_group_counts':dict(Counter(group_split.values())),
        'split_method': 'SHA256('+SALT+'<connected component of queries sharing positive docs>), component-wise 30/20/50',
        'full_corpus_available':not allow_missing_corpus,
        'caution':'Public benchmarks are not samples of actual my-search saved-article search sessions; do not claim product-wide 95% success.',
        'sha256': {p:sha(out/p) for p in ('corpus.jsonl','queries.jsonl','qrels.tsv','splits.jsonl')}
    }
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return manifest

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--dataset',choices=('jagov','miracl-ja','fixture'),default='jagov')
    p.add_argument('--out',type=Path,default=Path('downloads/jagov'))
    args=p.parse_args()
    if args.dataset=='jagov':
        docs,queries,rels,revision=load_jagov()
    elif args.dataset=='miracl-ja':
        docs,queries,rels,revision=load_miracl_ja(args.out)
    else:
        docs,queries,rels=make_fixture()
        revision='SYNTHETIC_TEST_ONLY'
    manifest=prepare(docs,queries,rels,args.out,args.dataset,allow_missing_corpus=args.dataset=='miracl-ja',source_revision=revision)
    print(json.dumps(manifest,ensure_ascii=False,indent=2))
    if args.dataset=='miracl-ja':
        print('WARNING: MIRACL original corpus not fetched. No full-ranking/Hit@10 evaluation is valid yet.', file=sys.stderr)

if __name__=='__main__': main()
