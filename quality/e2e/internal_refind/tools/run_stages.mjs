#!/usr/bin/env node
// Run staged read-only benchmarks against a running local API; semantic holdout stays off by default.
import {spawnSync} from 'node:child_process';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function opt(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
const base=opt('--base','http://127.0.0.1:3000');
const outDir=resolve(opt('--out-dir',join(root,'reports','baseline')));
const compareDir=opt('--compare-dir',undefined);
const strict=args.includes('--strict');
const includeHoldout=args.includes('--include-holdout');
const names=['00_negative','00b_previous_smoke','01_literal','01b_live_titles','02_terms_paraphrase','03_memory_typo',...(includeHoldout?['04_holdout']:[])];
await mkdir(outDir,{recursive:true});
const results=[];
for(const name of names){
 const file=join(root,'cases',name+'.json');
 try{await access(file);}catch{if(name==='01b_live_titles'){console.log(`SKIPPING ${name}: run make_live_title_cases.mjs first`);continue;}throw Error(`Missing stage file: ${file}`);}
 const reportPath=join(outDir,name+'.json');
 const cmd=[join(root,'tools','eval_refind.mjs'),'--cases',file,'--base',base,'--out',reportPath];
 if(compareDir){const ref=resolve(compareDir,name+'.json');try{await access(ref);cmd.push('--compare',ref);}catch{throw Error(`Missing baseline: ${ref}`);}}
 if(strict)cmd.push('--strict');
 console.log('\n==== STAGE '+name+' ====');
 const run=spawnSync(process.execPath,cmd,{stdio:'inherit'});
 const payload=JSON.parse(await readFile(reportPath,'utf8'));
 results.push({name,passed:payload.gate.passed,...payload.overall,deltaHit10PP:payload.comparison?.deltaHit10PP??null,regressions:payload.comparison?.regressed.length??null});
 if(run.error)throw run.error;
 if(run.status!==0 && strict) console.log(`STAGE ${name} failed; continuing to report all stages`);
}
const allPassed=results.every(x=>x.passed);
const summary={ranAt:new Date().toISOString(),outDir,includeHoldout,allPassed,stages:results,notice:'Stages are title-derived, correlated, and not a statistical 95% real-world recall estimate.'};
await writeFile(join(outDir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log('\n======== SUMMARY ========');
for(const r of results) console.log(`${r.passed?'PASS':'FAIL'} ${r.name.padEnd(23)} Hit@10=${String(r.hit10Percent).padStart(6)}% p95=${String(r.p95Ms).padStart(7)}ms missing=${r.missingTargets} errors=${r.errors}${r.deltaHit10PP!==null?' delta='+r.deltaHit10PP+'pp':''}`);
console.log('Saved',join(outDir,'summary.json'));
if(strict && !allPassed)process.exitCode=1;
