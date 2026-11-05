#!/usr/bin/env python3
"""Export standalone card fixtures from harvested article metadata, never touch the user's DB."""
import argparse,hashlib,json,pathlib
p=argparse.ArgumentParser();p.add_argument('--corpus',default='local_article_corpus/articles.jsonl');p.add_argument('--output',default='local_article_corpus/cards_fixture.jsonl');a=p.parse_args()
docs=[json.loads(line) for line in pathlib.Path(a.corpus).read_text(encoding='utf8').splitlines() if line.strip()]
out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
with out.open('w',encoding='utf8') as f:
    for d in docs:
        has_body=d.get('body_included',False) and bool(d.get('body'))
        row={'id':d['id'],'title':d['title'],'body':d['body'] if has_body else d.get('summary',''),
             'summary':d.get('summary',''),'url':d['url'],'tags':d.get('tags',[]),
             'type':'memo','archived':False,'fixture_metadata':{'source':d['source'],'full_text':bool(has_body)}}
        f.write(json.dumps(row,ensure_ascii=False)+'\n')
print('Exported',len(docs),'card fixtures; full_text',sum(bool(d.get('body_included')) for d in docs),'->',str(out))
