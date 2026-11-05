#!/usr/bin/env node
// Local mock-server harness test. Does not contact or modify my-search.
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const targets=(JSON.parse(await readFile(join(root,'data_targets.json'),'utf8'))).targets.map(x=>({id:x.targetCardIds[0],title:x.targetTitle,body:'',summary:'',tags:[]}));
const app=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(u.pathname.startsWith('/api/cards/')){
    const c=targets.find(x=>x.id===decodeURIComponent(u.pathname.slice('/api/cards/'.length)));
    res.statusCode=c?200:404;res.end(JSON.stringify(c || {error:'Not found'}));return;
  }
  if(u.pathname==='/api/cards'){
    const q=u.searchParams.get('q')?.toLowerCase()||'';
    const rows=targets.filter(x=>!q || x.title.toLowerCase().includes(q)).slice().reverse();
    const offset=Math.max(0,Number(u.searchParams.get('offset')||0));
    const limit=Math.min(100,Number(u.searchParams.get('limit')||20));
    res.end(JSON.stringify({items:rows.slice(offset,offset+limit),total:rows.length,offset,limit}));return;
  }
  res.statusCode=404;res.end(JSON.stringify({error:'Not found'}));
});
await new Promise(ok=>app.listen(0,'127.0.0.1',ok));
const base=`http://127.0.0.1:${app.address().port}`;
const tmp=await mkdtemp(join(tmpdir(),'mysrch-eval-test-'));
try {
 // spawnSync blocks server's own event loop: use async spawn instead.
 const {spawn}=await import('node:child_process');
 async function cmd(script,args){return await new Promise((done,reject)=>{
   const child=spawn(process.execPath,[join(root,'tools',script),...args],{stdio:['ignore','pipe','pipe']});let output='';
   child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
   child.on('error',reject);child.on('close',code=>done({code,output}));
 });}
 const nc=await cmd('eval_refind.mjs',['--base',base,'--cases',join(root,'cases','00_negative.json'),'--out',join(tmp,'neg.json'),'--strict']);
 if(nc.code!==0)throw Error('Negative suite failed: '+nc.output);
 const lc=await cmd('eval_refind.mjs',['--base',base,'--cases',join(root,'cases','01_literal.json'),'--out',join(tmp,'literal.json')]);
 if(lc.code!==0)throw Error('Literal suite script failed: '+lc.output);
 const lr=JSON.parse(await readFile(join(tmp,'literal.json'),'utf8'));
 if(lr.overall.cases!==48 || lr.overall.errors!==0 || lr.overall.missingTargets!==0 || lr.overall.hit10===0)throw Error('Unexpected literal mock summary '+JSON.stringify(lr.overall));
 const lc2=await cmd('eval_refind.mjs',['--base',base,'--cases',join(root,'cases','01_literal.json'),'--out',join(tmp,'literal2.json'),'--compare',join(tmp,'literal.json')]);
 if(lc2.code!==0)throw Error('compare failed '+lc2.output);
 const cr=JSON.parse(await readFile(join(tmp,'literal2.json'),'utf8'));
 if(cr.comparison.regressed.length!==0 || cr.comparison.deltaHit10PP!==0) throw Error('Comparing identical runs should not regress');
 const dyn=await cmd('make_live_title_cases.mjs',['--base',base,'--out',join(tmp,'dynamic.json')]);
 if(dyn.code!==0)throw Error('Dynamic title suite failed '+dyn.output);
 const dr=JSON.parse(await readFile(join(tmp,'dynamic.json'),'utf8'));
 if(dr.cardCount!==30 || dr.cases.length!==30)throw Error('Unexpected generated fixture length');
 const batched=await cmd('run_stages.mjs',['--base',base,'--out-dir',join(tmp,'stages')]);
 if(batched.code!==0)throw Error('Batch stage runner failed '+batched.output);
 const summary=JSON.parse(await readFile(join(tmp,'stages','summary.json'),'utf8'));
 if(summary.stages.length!==5 || !summary.stages.some(x=>x.name==='00b_previous_smoke')) throw Error('Batch suite has unexpected stages');
 console.log('PASS: local GET mock, negatives, 48 literal cases, report comparison, full title fixture, staged batch (including prior 134 cases).');
} finally {await new Promise(done=>app.close(done));await rm(tmp,{recursive:true,force:true});}
