import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const root=new URL('../',import.meta.url);
export const read=p=>JSON.parse(readFileSync(new URL(p,root),'utf8'));
export const hash=p=>createHash('sha256').update(readFileSync(new URL(p,root))).digest('hex');
export const rubric=read('rubric/criteria.json');
export const ids=readdirSync(new URL('cases/',root)).filter(x=>/^TC\d{2}\.json$/.test(x)).sort().map(x=>x.slice(0,-5));
export const scorePath=(reviewer,id)=>new URL(`scorecards/${reviewer}/${id}.json`,root);
export function assert(cond,message){ if(!cond)throw Error(message); }
export function validReviewer(v){ assert(/^[a-z][a-z0-9-]{0,39}$/.test(v??''),'reviewer ID invalid'); }
export function checkCard(card,id,reviewer){
 assert(card && card.case_id===id,`${id}: case_id mismatch`);
 assert(card.rubric_version===rubric.rubric_version,`${id}: rubric version mismatch`);
 assert(card.rubric_sha256===hash('rubric/criteria.json'),`${id}: rubric hash mismatch`);
 assert(card.report_sha256===hash(`cases/${id}.json`),`${id}: report hash mismatch`);
 assert(card.reviewer===reviewer,`${id}: reviewer mismatch`);
 assert(Array.isArray(card.checks)&&card.checks.length===rubric.checks.length,`${id}: wrong number of checks`);
 let criticalFailures=0,pass=0,fail=0,pending=0,na=0;
 for(const [i,c] of card.checks.entries()){
  const r=rubric.checks[i];
  assert(c.id===r.id,`${id}: criterion ID/order mismatch: ${i}`);
  assert(['pass','fail','pending','not_applicable'].includes(c.status),`${id}/${c.id}: invalid status`);
  assert(typeof c.reason==='string'&&c.reason.trim(),`${id}/${c.id}: reason required`);
  assert(typeof c.evidence==='string',`${id}/${c.id}: evidence must be string`);
  if(c.status==='pass'||c.status==='fail') assert(c.evidence.trim(),`${id}/${c.id}: evidence required for pass/fail`);
  if(c.status==='not_applicable') na++;
  if(c.status==='pending')pending++;
  if(c.status==='pass')pass++;
  if(c.status==='fail'){fail++;if(r.severity==='critical')criticalFailures++;}
 }
 return {pass,fail,pending,not_applicable:na,critical_failures:criticalFailures};
}
