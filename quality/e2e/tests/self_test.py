#!/usr/bin/env python3
"""Local synthetic fixtures ONLY; verifies data adapter, binomial math, isolated server harness and study workflow."""
import builtins, io, json, os, pathlib, subprocess, sys, tempfile, unittest, zipfile
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import get_tomt, stats, live_study, benchmark_api

def fake_zip():
    docs=[{'id':'item'+str(i), 'title':'Book '+str(i),'text':'Written description '+str(i)} for i in range(75)]
    queries=[{'id':'qid'+str(i),'title':'Looking for something numbered '+str(i), 'description':'I remember something about it.'} for i in range(150)]
    qrels=['qid'+str(i)+'\t0\titem'+str(i%75)+'\t1' for i in range(150)]
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr('Books/documents.json','\n'.join(json.dumps(x) for x in docs)+'\n')
        z.writestr('Books/queries.json','\n'.join(json.dumps(x) for x in queries)+'\n')
        z.writestr('Books/qrels.txt','\n'.join(qrels)+'\n')
    return out.getvalue()

MOCK='''import http.server,json,os,urllib.parse,re
cards={}
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  n=int(self.headers['Content-Length']); o=json.loads(self.rfile.read(n)); u=urllib.parse.urlparse(self.path)
  if u.path=='/api/search/terms':
   terms=re.findall(r'[A-Za-z0-9]+',o['text'].lower()); result={'keywords':[{'term':x,'weight':1} for x in terms],'analysis':{}}
  elif u.path=='/api/cards/search':
   terms=[x['term'].lower() for x in o['config']['keywords']]
   rows=[{'article':{'id':i,'title':v['title']},'score':1} for i,v in cards.items() if any(t in (v['title']+' '+v['body']).lower() for t in terms)]
   result={'active':rows,'scope':{'totalCount':len(cards)}}
  elif u.path=='/api/cards':
   cid=str(len(cards)+1);cards[cid]=o;result={'id':cid,**o}
  else:self.send_error(404);return
  b=json.dumps(result).encode();self.send_response(201 if u.path=='/api/cards' else 200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  u=urllib.parse.urlparse(self.path)
  if u.path=='/healthz':
   b=json.dumps({'ok':True,'status':'healthy'}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  if u.path=='/api/modes':
   b=json.dumps({'impl':{'description':'','k1':1.2,'b':.75,'lambda':0,'contextBonus':1.5}}).encode();self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  if u.path!='/api/cards':self.send_error(404);return
  q=urllib.parse.parse_qs(u.query).get('q',[''])[0].lower()
  rows=[{'id':i} for i,v in cards.items() if q in v['title'].lower() or q in v['body'].lower()]
  b=json.dumps({'items':rows[:10],'total':len(rows)}).encode()
  self.send_response(200);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
http.server.HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()
'''

class Tests(unittest.TestCase):
 def test_jsonl_reader_preserves_unicode_line_separators(self):
    with tempfile.TemporaryDirectory() as d:
        path=pathlib.Path(d)/'unicode.jsonl'
        path.write_text(json.dumps({'text':'first\u2028second\u2029third'},ensure_ascii=False)+'\n',encoding='utf-8')
        self.assertEqual(benchmark_api.read_lines(path),[{'text':'first\u2028second\u2029third'}])

 def test_statistics(self):
    self.assertAlmostEqual(stats.lower_exact(500,500),.025**(1/500),10)
    self.assertTrue(stats.certify(485,500)['passes'])
    self.assertFalse(stats.certify(484,500)['passes'])
    self.assertFalse(stats.certify(475,500)['passes'])
 def test_official_adapter_shape_no_answer_leakage(self):
    with tempfile.TemporaryDirectory() as d:
        report=get_tomt.adapt_zip(fake_zip(),'Books',pathlib.Path(d),'synthetic-fixture')
        self.assertEqual(report['documents'],75)
        self.assertEqual(report['eligible'],150)
        rows=[json.loads(x) for x in pathlib.Path(d,'development.jsonl').read_text().splitlines()]
        self.assertTrue(all('replies' not in str(r) and r['source']=='reddit-human-recollection' for r in rows))
        groups={}
        for part in ['development','validation','holdout']:
            for line in pathlib.Path(d,part+'.jsonl').read_text().splitlines():
                r=json.loads(line)
                self.assertNotIn(r['group_id'],groups) if r['group_id'] in groups and groups[r['group_id']]!=part else None
                groups[r['group_id']]=part
 def test_isolated_benchmark_harness_and_no_production_db(self):
    with tempfile.TemporaryDirectory() as d:
        d=pathlib.Path(d);data=d/'reddit';get_tomt.adapt_zip(fake_zip(),'Books',data,'synthetic-fixture')
        repo=d/'repo';repo.mkdir();(repo/'server.ts').write_text('fake server');(repo/'package.json').write_text('{}')
        mock=d/'mock_server.py';mock.write_text(MOCK)
        bdir=d/'bin';bdir.mkdir()
        if os.name == 'nt':
            npm=bdir/'npm.cmd';npm.write_text('@echo off\r\n"'+sys.executable+'" "'+str(mock)+'"\r\n')
        else:
            npm=bdir/'npm';npm.write_text('#!/bin/sh\nexec '+sys.executable+' "'+str(mock)+'"\n');npm.chmod(0o755)
        outfile=d/'out.json';env=dict(os.environ,PATH=str(bdir)+os.pathsep+os.environ.get('PATH',''))
        proc=subprocess.run([sys.executable,str(ROOT/'tools/benchmark_api.py'),'--repo',str(repo),
            '--data',str(data),'--max-queries','4','--stage','development','--out',str(outfile)],env=env,capture_output=True,text=True,timeout=60)
        self.assertEqual(proc.returncode,0,proc.stderr+proc.stdout)
        result=json.loads(outfile.read_text());self.assertTrue(result['diagnostic_only']);self.assertEqual(result['stats']['n'],4)
        self.assertIn('tempfile SQLite',result['isolation'])
 def test_live_study(self):
    with tempfile.TemporaryDirectory() as d:
        live_study.STUDY=pathlib.Path(d)/'study'
        plan=type('A',(),{'build_id':'mock-build-123','n':2,'scope':'personal-longitudinal','population':'one consenting personal user'})
        with patch('builtins.print'):live_study.init(plan)
        class Stub:pass
        for i in range(2):
            sid='sid'+str(i)
            live_study.append('session',{'sid':sid,'study_id':live_study.protocol()['study_id'],'participant':'user1',
                'build_id':'mock-build-123','query':'normal\u2028human query' if i == 0 else 'normal human query','top10':[] if i == 0 else ['card1'],'latency_ms':1,
                'http_status':200,'error':None,'source':'test-fixture','consent_declared':True})
            if i == 0:
                live_study.append('interaction',{'sid':sid,'action':'search_response','top10':['card1'],'error':None,'http_status':200})
                live_study.append('interaction',{'sid':sid,'action':'opened','card_id':'card1'})
            live_study.append('adjudication',{'sid':sid,'gold_id':'card1','status':'verified','reviewed_by_human':True,
                'opened_card_id':None if i == 0 else 'card1','elapsed_seconds':None if i == 0 else 3,
                'query_count':None if i == 0 else 1,'label_note':'SYNTHETIC TEST','human_declared':True})
        with patch('builtins.print'):live_study.seal(None);live_study.final(None)
        final=json.loads((live_study.STUDY/'final.json').read_text())
        self.assertEqual(final['status'],'PERSONAL_EXPLORATORY_ONLY')
        self.assertEqual(final['first_query_hit10']['n'],2)
        with self.assertRaises(ValueError):live_study.final(None)
 def test_retention_expiry_removes_raw_data(self):
    with tempfile.TemporaryDirectory() as d:
        live_study.STUDY=pathlib.Path(d)/'study';live_study.STUDY.mkdir()
        (live_study.STUDY/'protocol.json').write_text(json.dumps({'study_id':'expired-test','attempt':1,'expires_utc':'2000-01-01T00:00:00Z'}))
        (live_study.STUDY/'events.jsonl').write_text('{"query":"private fixture"}\n')
        self.assertTrue(live_study.expire_if_past_due())
        self.assertFalse((live_study.STUDY/'protocol.json').exists())
        self.assertFalse((live_study.STUDY/'events.jsonl').exists())
        registry=json.loads((live_study.STUDY/'registry.json').read_text())
        self.assertEqual(registry['attempts'][0]['status'],'EXPIRED_BY_RETENTION')
        self.assertNotIn('private fixture',json.dumps(registry))

if __name__=='__main__':unittest.main(verbosity=2)
