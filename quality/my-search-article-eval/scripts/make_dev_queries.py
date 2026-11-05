#!/usr/bin/env python3
"""Produce explicitly SYNTHETIC smoke/regression questions for development only.
Never use synthetic cases for final statistical certification.
"""
import argparse,csv,json,pathlib,re
p=argparse.ArgumentParser();p.add_argument('--corpus',default='local_article_corpus/articles.jsonl');p.add_argument('--plan',default='local_article_corpus/plan');a=p.parse_args()
corpus={x['id']:x for x in (json.loads(l) for l in pathlib.Path(a.corpus).read_text(encoding='utf8').splitlines() if l.strip())}
for split in ['development','validation']:
    path=pathlib.Path(a.plan)/(split+'_annotation_blank.csv')
    rows=list(csv.DictReader(path.open(encoding='utf8',newline='')))
    outfile=pathlib.Path(a.plan)/(split+'_synthetic_queries.jsonl')
    with outfile.open('w',encoding='utf8') as f:
        for i,row in enumerate(rows):
            doc=corpus[row['target_doc_id']]
            title=doc['title']
            title=re.sub(r'[\[\]【】\(\)（）「」『』]',' ',title)
            parts=re.split(r'[:：\-｜|、，,・/]',title)
            phrase=max(parts,key=lambda x:len(x.strip())).strip() if parts else title
            if i%3==0: query=phrase[:40]
            elif i%3==1: query=' '.join(doc.get('tags',[])[:2]) or phrase[:35]
            else: query=' '.join(re.findall(r'[A-Za-z0-9+#.-]{3,}|[\u3040-\u30ff\u3400-\u9fff]{2,}',title)[:4]) or phrase[:40]
            q={'query_id':row['query_id'],'query':query,'target_doc_id':doc['id'],'query_origin':'synthetic',
               'source':'title_or_tags_self_derived','eligible_for_statistical_certification':False}
            f.write(json.dumps(q,ensure_ascii=False)+'\n')
    print(split,len(rows),'synthetic queries ->',outfile)
