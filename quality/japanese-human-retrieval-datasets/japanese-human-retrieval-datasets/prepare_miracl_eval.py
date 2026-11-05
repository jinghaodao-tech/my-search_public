#!/usr/bin/env python3
"""Prepare leakage-aware MIRACL splits while excluding previously evaluated qids."""
from __future__ import annotations
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

SALT = 'my-search-miracl-ja-split-v1|'

def read_jsonl(path: Path):
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]

def sha(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1<<20),b''):h.update(block)
    return h.hexdigest()

def main() -> None:
    p=argparse.ArgumentParser()
    p.add_argument('--labels-dir',type=Path,required=True)
    p.add_argument('--corpus-manifest',type=Path,required=True)
    p.add_argument('--previous-eval',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    label_manifest=json.loads((args.labels_dir/'manifest.json').read_text(encoding='utf-8'))
    corpus_manifest=json.loads(args.corpus_manifest.read_text(encoding='utf-8'))
    if corpus_manifest.get('document_count') != 6_953_614:
        raise ValueError('Complete official MIRACL ja corpus integrity manifest required')
    query_rows=read_jsonl(args.labels_dir/'queries.jsonl')
    qrels=defaultdict(list)
    for line in (args.labels_dir/'qrels.tsv').read_text(encoding='utf-8').splitlines():
        if line.strip():
            qid,_,did,grade=line.split()
            qrels[qid].append((did,int(grade)))
    old=json.loads(args.previous_eval.read_text(encoding='utf-8'))
    used={str(row['queryId']) for row in old['perQuery']['A0-current-custom']}
    used_qids={'dev:'+qid for qid in used}
    query_by_id={row['id']:row for row in query_rows}
    if not used_qids <= query_by_id.keys():
        raise ValueError('Prior MIRACL queries not found in current official labels')
    positive={qid:{did for did,grade in qrels[qid] if grade>0} for qid in query_by_id}
    parent={qid:qid for qid in query_by_id}
    def find(qid):
        while parent[qid]!=qid:
            parent[qid]=parent[parent[qid]]
            qid=parent[qid]
        return qid
    doc_owner={}
    for qid,doc_ids in positive.items():
        for did in doc_ids:
            other=doc_owner.get(did)
            if other is None:
                doc_owner[did]=qid
            else:
                a,b=find(qid),find(other)
                if a!=b:parent[a]=b
    components=defaultdict(list)
    for qid in query_by_id:components[find(qid)].append(qid)
    canonical={root:min(items) for root,items in components.items()}
    selected={'development':[],'validation':[],'holdout':[]}
    consumed_components=0
    blocked_train=0
    train_groups=[]
    for root,items in components.items():
        dev=[qid for qid in items if query_by_id[qid].get('original_split')=='dev']
        train=[qid for qid in items if query_by_id[qid].get('original_split')=='train']
        if any(qid in used_qids for qid in dev):
            consumed_components+=1
            continue
        if dev:
            selected['holdout'].extend(dev)
            blocked_train+=len(train)
        else:
            train_groups.append((canonical[root],train))
    ordered=sorted(train_groups,key=lambda item:hashlib.sha256((SALT+item[0]).encode()).hexdigest())
    cutoff=int(len(ordered)*.8)
    for index,(_,items) in enumerate(ordered):
        selected['development' if index<cutoff else 'validation'].extend(items)
    if not selected['holdout'] or not selected['development'] or not selected['validation']:
        raise ValueError('Insufficient official split data after leakage exclusions')
    selected_qids={qid for values in selected.values() for qid in values}
    if selected_qids & used_qids:
        raise ValueError('Previously evaluated query leaked into an evaluation split')
    groups_for={qid:canonical[find(qid)] for qid in selected_qids}
    target_stage={}
    for stage,qids in selected.items():
        for qid in qids:
            for did in positive[qid]:
                prior=target_stage.setdefault(did,stage)
                if prior!=stage:raise AssertionError(f'Positive target leaks between splits: {did}')
    args.out.mkdir(parents=True,exist_ok=True)
    for stage,qids in selected.items():
        with (args.out/f'{stage}.jsonl').open('w',encoding='utf-8',newline='\n') as stream:
            for qid in sorted(qids):
                row=query_by_id[qid]
                stream.write(json.dumps({'id':qid,'query':row['query'],'gold_ids':sorted(positive[qid]),
                    'group_id':groups_for[qid],'split':stage,'original_split':row['original_split']},ensure_ascii=False,separators=(',',':'))+'\n')
    with (args.out/'queries.jsonl').open('w',encoding='utf-8',newline='\n') as stream:
        for stage in ('development','validation','holdout'):
            for line in (args.out/f'{stage}.jsonl').read_text(encoding='utf-8').splitlines():stream.write(line+'\n')
    with (args.out/'splits.jsonl').open('w',encoding='utf-8',newline='\n') as stream:
        for stage,qids in selected.items():
            for qid in sorted(qids):stream.write(json.dumps({'id':qid,'group_id':groups_for[qid],'split':stage},separators=(',',':'))+'\n')
    with (args.out/'qrels.tsv').open('w',encoding='utf-8',newline='\n') as stream:
        for qid in sorted(selected_qids):
            for did,grade in sorted(qrels[qid]):stream.write(f'{qid}\t0\t{did}\t{grade}\n')
    prior_hash=sha(args.previous_eval)
    manifest={
        'dataset':'MIRACL Japanese official full-corpus retrieval',
        'label_source_revision':label_manifest['source_revision'],
        'corpus_revision':corpus_manifest['revision'],
        'created_utc':datetime.now(timezone.utc).isoformat(),
        'document_count':corpus_manifest['document_count'],'full_corpus_available':True,
        'query_counts':{stage:len(qids) for stage,qids in selected.items()},
        'component_counts':{stage:len({groups_for[qid] for qid in qids}) for stage,qids in selected.items()},
        'prior_miracl_eval_sha256':prior_hash,'excluded_previous_query_count':len(used),
        'excluded_previous_query_ids_sha256':hashlib.sha256(('\n'.join(sorted(used))).encode()).hexdigest(),
        'excluded_connected_components':consumed_components,
        'train_queries_excluded_due_to_holdout_target_overlap':blocked_train,
        'split_method':'group positive-qrel connected components; official train components hashed 80/20 to development/validation; untouched official dev components reserved for holdout',
        'caution':'MIRACL qrels are human relevance judgments for Wikipedia passage retrieval, not observed my-search saved-article sessions.',
        'sha256':{name:sha(args.out/name) for name in ('queries.jsonl','qrels.tsv','splits.jsonl','development.jsonl','validation.jsonl','holdout.jsonl')},
    }
    (args.out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(manifest,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
