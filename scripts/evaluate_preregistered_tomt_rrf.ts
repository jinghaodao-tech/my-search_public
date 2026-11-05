import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type Arm = {top50:string[];error:string|null};
type Row = {id:string;group_id:string;gold_ids:string[];bm25:Arm;fts5Rrf:Arm};
const [inputArg,outputArg]=process.argv.slice(2);
if(!inputArg||!outputArg)throw new Error('Usage: npx tsx scripts/evaluate_preregistered_tomt_rrf.ts <movies-dev-paired.json> <new-output.json>');
const inputPath=path.resolve(inputArg),outputPath=path.resolve(outputArg);
if(fs.existsSync(outputPath))throw new Error(`Refusing to overwrite ${outputPath}`);
const source=JSON.parse(fs.readFileSync(inputPath,'utf8')) as {dataset:{name:string;split:string;sourceSha256:string;queriesSha256:string;querySampling?:{requestedGroups:number;offset:number;selectedGroups:number;selectionSha256:string}};perQuery:Row[]};
if(!source.dataset.name.endsWith('Movies')||!/^development\b/i.test(source.dataset.split)||source.dataset.querySampling?.requestedGroups!==500||source.dataset.querySampling.offset!==2||source.perQuery.length!==500)throw new Error('Input does not match the preregistered 500-group Movies development sample.');
const groups=new Map<string,number[]>();
source.perQuery.forEach((row,index)=>groups.set(row.group_id,[...(groups.get(row.group_id)??[]),index]));
if(groups.size!==500)throw new Error(`Expected 500 target groups, found ${groups.size}.`);
const score=(ids:string[],goldIds:string[])=>{
  const gold=new Set(goldIds),rank=ids.findIndex(id=>gold.has(id)),top10=ids.slice(0,10);
  const dcg=top10.reduce((sum,id,index)=>sum+(gold.has(id)?1/Math.log2(index+2):0),0);
  const ideal=Array.from({length:Math.min(gold.size,10)},(_,index)=>1/Math.log2(index+2)).reduce((sum,value)=>sum+value,0);
  return {hit1:rank===0,hit10:rank>=0&&rank<10,mrr10:rank>=0&&rank<10?1/(rank+1):0,ndcg10:ideal?dcg/ideal:0};
};
const base=source.perQuery.map(row=>row.bm25.error?score([],row.gold_ids):score(row.bm25.top50,row.gold_ids));
const fused=source.perQuery.map(row=>{
  if(row.bm25.error||row.fts5Rrf.error)return score([],row.gold_ids);
  const ranked=new Map<string,{score:number;bm25Rank:number;ftsRank:number}>();
  row.bm25.top50.forEach((id,index)=>ranked.set(id,{score:1/(61+index),bm25Rank:index+1,ftsRank:Infinity}));
  row.fts5Rrf.top50.forEach((id,index)=>{const old=ranked.get(id);if(old){old.score+=0.1/(61+index);old.ftsRank=index+1;}else ranked.set(id,{score:0.1/(61+index),bm25Rank:Infinity,ftsRank:index+1});});
  const ids=[...ranked].sort((a,b)=>b[1].score-a[1].score||a[1].bm25Rank-b[1].bm25Rank||a[1].ftsRank-b[1].ftsRank||a[0].localeCompare(b[0])).map(([id])=>id);
  return score(ids,row.gold_ids);
});
const mean=(rows:typeof base)=>({hit1:rows.filter(row=>row.hit1).length,hit10:rows.filter(row=>row.hit10).length,mrr10:rows.reduce((sum,row)=>sum+row.mrr10,0)/rows.length,ndcg10:rows.reduce((sum,row)=>sum+row.ndcg10,0)/rows.length});
const both=base.filter((row,index)=>row.hit10&&fused[index]!.hit10).length;
const bm25Only=base.filter((row,index)=>row.hit10&&!fused[index]!.hit10).length;
const rrfOnly=fused.filter((row,index)=>row.hit10&&!base[index]!.hit10).length;
const neither=base.length-both-bm25Only-rrfOnly;
let seed=0x4d4f5649;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
const groupRows=[...groups.values()];
const bootstrap:number[]=[];
for(let iteration=0;iteration<10_000;iteration++){
  let delta=0,count=0;
  for(let draw=0;draw<groupRows.length;draw++)for(const index of groupRows[Math.floor(random()*groupRows.length)]!){delta+=Number(fused[index]!.hit10)-Number(base[index]!.hit10);count++;}
  bootstrap.push(delta/count);
}
bootstrap.sort((a,b)=>a-b);
const ci=[bootstrap[Math.floor(.025*(bootstrap.length-1))]!,bootstrap[Math.floor(.975*(bootstrap.length-1))]!];
const result={analysis:'single preregistered weight only; Movies development cross-domain confirmation, not independent final evaluation',
  inputs:{path:inputPath,sourceSha256:source.dataset.sourceSha256,querySampleSha256:source.dataset.queriesSha256,groupSampleSha256:source.dataset.querySampling!.selectionSha256,queries:source.perQuery.length,groups:groups.size,hashOffset:2},
  method:{rrfConstant:60,bm25Weight:1,fts5Weight:0.1,candidatePool:'union of recorded BM25 and FTS5 top-50; ranks outside either top-50 are not observable',bootstrap:'target-group cluster bootstrap, 10,000 replicates, fixed seed 0x4d4f5649'},
  errors:{bm25:source.perQuery.filter(row=>row.bm25.error).length,fts5Rrf:source.perQuery.filter(row=>row.fts5Rrf.error).length},
  baseline:mean(base),candidate:mean(fused),paired:{both,bm25Only,rrfOnly,neither,netHit10Difference:(rrfOnly-bm25Only)/base.length,clusterBootstrap95CI:ci,replicates:bootstrap.length},
  independentFinalEvaluation:'NOT_EVALUABLE: this is a development split, not a reserved article-refinding holdout.',
  perQuery:source.perQuery.map((row,index)=>({id:row.id,group_id:row.group_id,baselineHit10:base[index]!.hit10,candidateHit10:fused[index]!.hit10,baselineMrr10:base[index]!.mrr10,candidateMrr10:fused[index]!.mrr10})),
  outputSha256:null as string|null};
const payload=JSON.stringify(result,null,2);
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,payload,{flag:'wx'});
console.log(JSON.stringify({outputPath,baseline:result.baseline,candidate:result.candidate,paired:result.paired,errors:result.errors},null,2));
