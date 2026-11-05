#!/usr/bin/env python3
"""Create a deterministic isolated-API benchmark input from a prepared dataset."""
from __future__ import annotations
import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

def lines(path: Path):
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset-dir', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((args.dataset_dir / 'manifest.json').read_text(encoding='utf-8'))
    if not manifest.get('full_corpus_available'):
        raise ValueError('Refusing to make a ranking dataset without the full corpus')
    docs = list(lines(args.dataset_dir / 'corpus.jsonl'))
    queries = {x['id']: x for x in lines(args.dataset_dir / 'queries.jsonl')}
    splits = {x['id']: x for x in lines(args.dataset_dir / 'splits.jsonl')}
    qrels = defaultdict(list)
    for row in (line.split() for line in (args.dataset_dir / 'qrels.tsv').read_text(encoding='utf-8').splitlines() if line.strip()):
        qid, _, did, grade = row
        if int(grade) > 0:
            qrels[qid].append(did)
    doc_ids = {x['id'] for x in docs}
    if len(doc_ids) != len(docs) or set(queries) != set(splits):
        raise ValueError('duplicate document IDs or inconsistent query/split IDs')
    if set(qrels) != set(queries) or any(not set(ids) <= doc_ids for ids in qrels.values()):
        raise ValueError('missing labels or positive documents outside full corpus')
    args.out.mkdir(parents=True, exist_ok=True)
    output_docs = [{'id': d['id'], 'title': d.get('title',''), 'body': d['text'], 'tags': []} for d in docs]
    with (args.out / 'documents.jsonl').open('w', encoding='utf-8', newline='\n') as stream:
        for row in output_docs:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(',',':')) + '\n')
    for stage in ('development','validation','holdout'):
        path = args.out / f'{stage}.jsonl'
        selected = [qid for qid, split in splits.items() if split['split'] == stage]
        with path.open('w', encoding='utf-8', newline='\n') as stream:
            for qid in sorted(selected):
                row = {'id':qid, 'query':queries[qid]['query'], 'gold_ids':sorted(set(qrels[qid])),
                       'group_id':splits[qid]['group_id'], 'split':stage}
                stream.write(json.dumps(row, ensure_ascii=False, separators=(',',':')) + '\n')
    corpus_sha = sha(args.dataset_dir / 'corpus.jsonl')
    q_sha = sha(args.dataset_dir / 'queries.jsonl')
    r_sha = sha(args.dataset_dir / 'qrels.tsv')
    provenance = {
        'dataset':manifest['dataset'], 'domain':'jagovfaqs', 'source_revision':manifest.get('source_revision'),
        'upstream_zip_sha256':hashlib.sha256((corpus_sha+q_sha+r_sha).encode()).hexdigest(),
        'corpus_sha256':corpus_sha, 'queries_sha256':q_sha, 'qrels_sha256':r_sha,
        'document_count':len(docs), 'query_count':len(queries),
        'query_authorship':'official FAQ questions written/selected by the source dataset process; not observed my-search sessions',
        'license':'CC-BY-4.0', 'positive_qrel_count':sum(map(len,qrels.values())),
        'notices':['Full document corpus included in every search.', 'FAQ question to answer mapping is the supplied relevance relation; not search-log click labels.'],
    }
    (args.out / 'provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'documents':len(docs),'queries':len(queries),'split_counts':{s:sum(x['split']==s for x in splits.values()) for s in ('development','validation','holdout')},'provenance':provenance},ensure_ascii=False,indent=2))

if __name__ == '__main__':
    main()
