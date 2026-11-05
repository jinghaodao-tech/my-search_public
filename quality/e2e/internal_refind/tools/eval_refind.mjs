#!/usr/bin/env node
// Read-only evaluation against the running my-search cards API. Node >=18; no npm dependencies.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
function option(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  if (i === argv.length - 1 || argv[i + 1].startsWith('--')) throw Error(`${flag} needs a value`);
  return argv[i + 1];
}
const has = x => argv.includes(x);
const casesPath = option('--cases', './cases/01_literal.json');
const base = option('--base', 'http://127.0.0.1:3000').replace(/\/$/, '');
const out = option('--out', `./reports/${(casesPath.split(/[\\/]/).at(-1) || 'cases').replace(/\.json$/, '')}.json`);
const compare = option('--compare', undefined);
const strict = has('--strict');
const timeoutMs = Math.max(1000, Number(option('--timeout-ms', '15000')));
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(base)) {
  throw Error('Refusing to send expected card IDs/queries to non-local server. Use http://127.0.0.1:PORT or localhost.');
}
const config = JSON.parse(await readFile(casesPath, 'utf8'));
if (!Array.isArray(config.cases) || !config.cases.length) throw Error('No cases supplied');
const seen = new Set();
for (const c of config.cases) {
  if (typeof c.id !== 'string' || !c.id || typeof c.query !== 'string' || !c.query.trim()) throw Error(`Bad case: ${JSON.stringify(c)}`);
  if (seen.has(c.id)) throw Error(`Duplicate case: ${c.id}`);
  seen.add(c.id);
  if (!c.expectedEmpty && (!Array.isArray(c.targetCardIds) || !c.targetCardIds.length)) throw Error(`Missing gold card ID: ${c.id}`);
  if (c.expectedEmpty && Array.isArray(c.targetCardIds)) throw Error(`Negative case must not have gold IDs: ${c.id}`);
}
const fingerprint = createHash('sha256').update(JSON.stringify(config.cases.map(c => [c.id, c.query, c.expectedEmpty, c.targetCardIds || []]))).digest('hex');
async function getJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {method:'GET', signal:controller.signal, headers:{'Accept':'application/json'}});
    if (!res.ok) { const e = Error(`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`); e.code = res.status; throw e; }
    return {data:await res.json(), ms:Math.round((performance.now()-start)*100)/100};
  } finally {clearTimeout(timer);}
}
function percentage(x,n){return n===0?null:Math.round(x/n*10000)/100;}
function quantile(vals, ratio){if (!vals.length) return null; const xs=[...vals].sort((a,b)=>a-b); return Math.round(xs[Math.ceil(xs.length*ratio)-1]*100)/100;}
function summarize(rows){
 const valid=rows.filter(r=>r.status==='ok');
 const positives=valid.filter(r=>!r.expectedEmpty);
 const negatives=valid.filter(r=>r.expectedEmpty);
 const hit=k=>positives.filter(x=>Number.isInteger(x.rank) && x.rank<=k).length;
 const falsePos=negatives.filter(x=>x.falsePositive).length;
 return {cases:rows.length, evaluated:valid.length, positives:positives.length,negatives:negatives.length,
   missingTargets:rows.filter(r=>r.status==='missing-target').length, errors:rows.filter(r=>r.status==='error').length,
   mismatchedTitles:rows.filter(r=>r.warning==='title-mismatch').length,
   hit1:hit(1), hit5:hit(5), hit10:hit(10),
   hit1Percent:percentage(hit(1), positives.length),hit5Percent:percentage(hit(5), positives.length),hit10Percent:percentage(hit(10), positives.length),
   rankSensitive:positives.filter(r=>r.totalMatches>10).length,
   rankSensitivePercent:percentage(positives.filter(r=>r.totalMatches>10).length,positives.length),
   negativeFalsePositives:falsePos, p50Ms:quantile(valid.map(r=>r.latencyMs),.5),p95Ms:quantile(valid.map(r=>r.latencyMs),.95)
 };
}
const existence=new Map();
const rows=[];
for (const c of config.cases) {
 const row={id:c.id,category:c.category || 'uncategorized',query:c.query,expectedEmpty:!!c.expectedEmpty,status:'ok',rank:null};
 try {
  if (!c.expectedEmpty) {
   const found=[];const bad=[];
   for (const id of c.targetCardIds) {
    if (!existence.has(id)){
     try {const r=await getJson(`/api/cards/${encodeURIComponent(id)}`); existence.set(id,{exists:r.data?.id===id,title:r.data?.title});}
     catch(e){if(e.code===404) existence.set(id,{exists:false});else throw e;}
    }
    const val=existence.get(id);
    if(val.exists){found.push(id); if(c.targetCardIds.length===1 && c.targetTitle && val.title!==c.targetTitle) bad.push(id);}
   }
   if(!found.length){row.status='missing-target';row.missingIds=c.targetCardIds;rows.push(row);continue;}
   if(bad.length) row.warning='title-mismatch';
  }
  const u=new URL('/api/cards',base);u.searchParams.set('q',c.query);u.searchParams.set('limit','10');
  const r=await getJson(`${u.pathname}${u.search}`);
  if(!r.data || !Array.isArray(r.data.items) || !Number.isInteger(r.data.total)) throw Error('Expected response {items:[], total:integer}');
  const ids=r.data.items.map(item=>item.id);
  row.latencyMs=r.ms;row.totalMatches=r.data.total;row.returnedIds=ids;
  if(c.expectedEmpty) row.falsePositive=r.data.total!==0 || ids.length!==0;
  else {const idx=ids.findIndex(id=>c.targetCardIds.includes(id));row.rank=idx<0?null:idx+1;}
 }catch(e){row.status='error';row.error=String(e);}
 rows.push(row);
 const result=row.status==='ok'?(c.expectedEmpty?(!row.falsePositive?'EMPTY':'FALSE_POSITIVE'):(row.rank??'MISS')):row.status;
 console.log(`${String(result).padEnd(14)} ${c.id}  ${c.query.slice(0,65)}`);
}
const overall=summarize(rows);
const categories=Object.fromEntries([...new Set(rows.map(x=>x.category))].sort().map(key=>[key,summarize(rows.filter(x=>x.category===key))]));
const report={version:2,generatedAt:new Date().toISOString(),source:casesPath,phase:config.phase||null,dataset:config.dataset||null,configStatus:config.status||null,base,caseFingerprint:fingerprint,notes:['Authored queries are not human search logs.','Case correlations by target mean Hit@10 does not estimate real user re-finding rate.','For negatives expect no results.','Never ignore missing targets or API errors.'],overall,categories,rows};
if(compare){
 const before=JSON.parse(await readFile(compare,'utf8'));
 if(before.caseFingerprint!==fingerprint) throw Error('Cannot compare reports: cases changed');
 const a=new Map(before.rows.map(r=>[r.id,r]));
 const change={improved:[],regressed:[],same:[]};
 for(const r of rows){
  const prev=a.get(r.id);if(!prev || r.status!=='ok' || prev.status!=='ok')continue;
  const value=x=>x.expectedEmpty?(x.falsePositive?0:11):(x.rank===null?0:11-x.rank);
  if(value(r)>value(prev))change.improved.push(r.id);
  else if(value(r)<value(prev))change.regressed.push(r.id);
  else change.same.push(r.id);
 }
 report.comparison={reference:compare,baseline:before.overall,deltaHit10PP:overall.hit10Percent==null||before.overall.hit10Percent==null?null:Math.round((overall.hit10Percent-before.overall.hit10Percent)*100)/100,...change};
}
const gate=config.gate??{};
const violations=[];
if(overall.missingTargets) violations.push(`${overall.missingTargets} missing target fixtures`);
if(overall.errors) violations.push(`${overall.errors} API errors`);
if(overall.mismatchedTitles) violations.push(`${overall.mismatchedTitles} changed target titles`);
if(gate.minHit10!=null && overall.hit10Percent!=null && overall.hit10Percent < gate.minHit10*100) violations.push(`Hit@10 ${overall.hit10Percent}% < ${gate.minHit10*100}%`);
if(gate.maxFalsePositives!=null && overall.negativeFalsePositives>gate.maxFalsePositives) violations.push(`negative false positives ${overall.negativeFalsePositives} > ${gate.maxFalsePositives}`);
report.gate={thresholds:gate, passed:violations.length===0, violations};
await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n','utf8');
console.log('\nSUMMARY', JSON.stringify(overall));
console.log('GATE',report.gate.passed?'PASS':`FAIL: ${violations.join('; ')}`);
console.log('REPORT',out);
if(strict && !report.gate.passed) process.exitCode=1;
