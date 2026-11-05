import fs from 'node:fs';
import path from 'node:path';

type QueryRow={id:string;group_id:string;gold_ids:string[];bm25:{top50:string[];error:string|null;latencyMs:number};fts5Rrf:{top50:string[];error:string|null;latencyMs:number}};
type StandardRow={qid:string;top10:string[];rankTop100:number|null;rankTop1000:number|null;latencyMs:number};
const [pairedArg,standardArg,outputArg]=process.argv.slice(2);
if(!pairedArg||!standardArg||!outputArg)throw new Error('Usage: npx tsx scripts/compare_tomt_movies_engines.ts <paired-api.json> <standard-bm25.json> <new-output.json>');
const pairedPath=path.resolve(pairedArg),standardPath=path.resolve(standardArg),outputPath=path.resolve(outputArg);
if(fs.existsSync(outputPath))throw new Error(`Refusing to overwrite ${outputPath}`);
const paired=JSON.parse(fs.readFileSync(pairedPath,'utf8')) as {dataset:{name:string;split:string;sourceSha256:string;queriesSha256:string;querySampling:{selectionSha256:string}};perQuery:QueryRow[]};
const standard=JSON.parse(fs.readFileSync(standardPath,'utf8')) as {method:string;queryCount:number;documentCount:number;results:StandardRow[]};
if(!paired.dataset.name.endsWith('Movies')||paired.perQuery.length!==500||standard.queryCount!==500)throw new Error('Expected the frozen 500-query Movies sample.');
const stdById=new Map(standard.results.map(row=>[row.qid,row]));
if(paired.perQuery.some(row=>!stdById.has(row.id))||stdById.size!==paired.perQuery.length)throw new Error('Standard BM25 rows do not exactly match paired API query IDs.');
const score=(ids:string[],goldIds:string[])=>{
  const gold=new Set(goldIds),rank=ids.findIndex(id=>gold.has(id)),top10=ids.slice(0,10);
  const dcg=top10.reduce((sum,id,index)=>sum+(gold.has(id)?1/Math.log2(index+2):0),0);
  const ideal=Array.from({length:Math.min(gold.size,10)},(_,index)=>1/Math.log2(index+2)).reduce((sum,value)=>sum+value,0);
  return {hit1:rank===0,hit10:rank>=0&&rank<10,mrr10:rank>=0&&rank<10?1/(rank+1):0,ndcg10:ideal?dcg/ideal:0};
};
const scored=paired.perQuery.map(row=>{
  const std=stdById.get(row.id)!;
  const standardScore=score(std.top10,row.gold_ids);
  const bm25Score=row.bm25.error?score([],row.gold_ids):score(row.bm25.top50,row.gold_ids);
  const ftsScore=row.fts5Rrf.error?score([],row.gold_ids):score(row.fts5Rrf.top50,row.gold_ids);
  const ranks=new Map<string,{score:number;bm25:number;fts:number}>();
  if(!row.bm25.error)row.bm25.top50.forEach((id,index)=>ranks.set(id,{score:1/(61+index),bm25:index+1,fts:Infinity}));
  if(!row.fts5Rrf.error)row.fts5Rrf.top50.forEach((id,index)=>{const old=ranks.get(id);if(old){old.score+=.1/(61+index);old.fts=index+1;}else ranks.set(id,{score:.1/(61+index),bm25:Infinity,fts:index+1});});
  const fusedIds=[...ranks].sort((a,b)=>b[1].score-a[1].score||a[1].bm25-b[1].bm25||a[1].fts-b[1].fts||a[0].localeCompare(b[0])).map(([id])=>id);
  const fusionScore=score(fusedIds,row.gold_ids);
  return {id:row.id,group:row.group_id,standard:standardScore,bm25:bm25Score,fts:ftsScore,fusion:fusionScore,
    standardHit100:std.rankTop100!==null,standardHit1000:std.rankTop1000!==null};
});
const metrics=(key:'standard'|'bm25'|'fts'|'fusion')=>({hit1:scored.filter(row=>row[key].hit1).length,hit10:scored.filter(row=>row[key].hit10).length,
  hit100:key==='standard'?scored.filter(row=>row.standardHit100).length:null,hit1000:key==='standard'?scored.filter(row=>row.standardHit1000).length:null,
  mrr10:scored.reduce((sum,row)=>sum+row[key].mrr10,0)/scored.length,ndcg10:scored.reduce((sum,row)=>sum+row[key].ndcg10,0)/scored.length});
const pairedComparison=(candidate:'bm25'|'fts'|'fusion')=>{
  const both=scored.filter(row=>row.standard.hit10&&row[candidate].hit10).length;
  const standardOnly=scored.filter(row=>row.standard.hit10&&!row[candidate].hit10).length;
  const candidateOnly=scored.filter(row=>!row.standard.hit10&&row[candidate].hit10).length;
  const neither=scored.length-both-standardOnly-candidateOnly;
  const groupRows=new Map<string,number[]>();
  scored.forEach((row,index)=>groupRows.set(row.group,[...(groupRows.get(row.group)??[]),index]));
  const groups=[...groupRows.values()];let seed=0x4d4f5649;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
  const bootstrap:number[]=[];
  for(let iteration=0;iteration<10_000;iteration++){
    let delta=0,count=0;
    for(let draw=0;draw<groups.length;draw++)for(const index of groups[Math.floor(random()*groups.length)]!){delta+=Number(scored[index]![candidate].hit10)-Number(scored[index]!.standard.hit10);count++;}
    bootstrap.push(delta/count);
  }
  bootstrap.sort((a,b)=>a-b);
  return {both,standardOnly,candidateOnly,neither,netHit10Difference:(candidateOnly-standardOnly)/scored.length,
    targetGroupBootstrap95CI:[bootstrap[Math.floor(.025*(bootstrap.length-1))]!,bootstrap[Math.floor(.975*(bootstrap.length-1))]!],replicates:bootstrap.length};
};
const result={audit:'same frozen 500 Movies queries and 8,845-doc corpus; development-only cross-domain comparison, not a final independent test',
  data:{sourceSha256:paired.dataset.sourceSha256,querySampleSha256:paired.dataset.queriesSha256,groupSampleSha256:paired.dataset.querySampling.selectionSha256,queries:scored.length,groups:new Set(scored.map(row=>row.group)).size,documentCount:standard.documentCount},
  definitions:{standard:'k1=1.2,b=0.75 BM25 over cached morphological tokens; shared query analysis; full-corpus scan',application:'production saved-card BM25 API path using same parsed query text and complete isolated corpus',fts5:'production saved-card FTS5/RRF API path',fusion:'rank fusion of application BM25 and FTS5/RRF Top50, RRF k=60, weights 1 and 0.1'},
  results:{standard:metrics('standard'),applicationBm25:metrics('bm25'),fts5Rrf:metrics('fts'),fixedFusion:metrics('fusion')},
  pairedAgainstStandard:{applicationBm25:pairedComparison('bm25'),fts5Rrf:pairedComparison('fts'),fixedFusion:pairedComparison('fusion')},
  latency:{standardBm25RankingOnlyMs:{p50:percentile(standard.results.map(row=>row.latencyMs),.5),p95:percentile(standard.results.map(row=>row.latencyMs),.95)},
    applicationApiMs:{p50:pairedSummaryLatency(paired.perQuery.map(row=>row.bm25)),p95:pairedSummaryLatency(paired.perQuery.map(row=>row.bm25),.95)},
    fts5ApiMs:{p50:pairedSummaryLatency(paired.perQuery.map(row=>row.fts5Rrf)),p95:pairedSummaryLatency(paired.perQuery.map(row=>row.fts5Rrf),.95)},
    note:'Standard BM25 numbers exclude HTTP and tokenization; API figures include parsing/API/SQLite work and are not directly comparable.'},
  errors:{applicationBm25:paired.perQuery.filter(row=>row.bm25.error).length,fts5Rrf:paired.perQuery.filter(row=>row.fts5Rrf.error).length},
  conclusion:'The fixed fusion weights were selected on Books development and are evaluated once here. This Movies sample is still development data; do not treat it as independent final evidence.'};
function percentile(values:number[],p:number){const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]??0;}
function pairedSummaryLatency(rows:Array<{latencyMs:number}>,p=.5){return percentile(rows.map(row=>row.latencyMs),p);}
const output=path.resolve(outputPath);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({output,results:result.results,pairedAgainstStandard:result.pairedAgainstStandard,latency:result.latency,errors:result.errors},null,2));
