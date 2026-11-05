#!/usr/bin/env python3
"""Commit a fixed query-group sample before any search result is computed."""
import argparse, hashlib, json, pathlib

def main():
    p=argparse.ArgumentParser();p.add_argument('--data',required=True);p.add_argument('--stage',required=True)
    p.add_argument('--limit',type=int,required=True);p.add_argument('--seed',required=True);p.add_argument('--out',required=True)
    p.add_argument('--exclude-manifest',action='append',default=[])
    a=p.parse_args();path=pathlib.Path(a.data)/f'{a.stage}.jsonl'
    rows=[json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    excluded=set()
    for manifest_path in a.exclude_manifest:
        manifest=json.loads(pathlib.Path(manifest_path).read_text(encoding='utf-8'))
        if manifest.get('stage')!=a.stage:raise ValueError('Excluded manifest stage does not match')
        excluded.update(manifest.get('group_ids',[]))
    group_ids=sorted({row['group_id'] for row in rows if row['group_id'] not in excluded},key=lambda group:hashlib.sha256((a.seed+'|'+group).encode('utf-8')).hexdigest())
    selected=group_ids[:a.limit]
    if len(selected)!=a.limit:raise ValueError(f'Requested {a.limit} groups but only found {len(selected)}')
    selected_set=set(selected);qids=sorted(row['id'] for row in rows if row['group_id'] in selected_set)
    manifest={'stage':a.stage,'seed':a.seed,'excluded_group_count':len(excluded),'group_limit':a.limit,'group_count':len(selected),'query_count':len(qids),
        'group_ids':selected,'query_ids':qids}
    canonical=json.dumps(manifest,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')
    manifest['manifest_sha256']=hashlib.sha256(canonical).hexdigest()
    out=pathlib.Path(a.out);out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in manifest.items() if k not in ('group_ids','query_ids')},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
