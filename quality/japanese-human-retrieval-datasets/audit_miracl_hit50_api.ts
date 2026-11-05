import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const [databaseArg, representativesArg, checkpointArg, outputArg] = process.argv.slice(2);
if (!databaseArg || !representativesArg || !checkpointArg || !outputArg) {
  throw new Error('Usage: npx tsx quality/japanese-human-retrieval-datasets/audit_miracl_hit50_api.ts <frozen-miracl.sqlite> <holdout-representatives.jsonl> <original-checkpoint.jsonl> <new-audit.jsonl>');
}
const databasePath = path.resolve(databaseArg);
const representativesPath = path.resolve(representativesArg);
const checkpointPath = path.resolve(checkpointArg);
const outputPath = path.resolve(outputArg);
if (!databasePath.endsWith(path.sep + 'miracl-full-fts.sqlite') || !databasePath.includes(path.sep + 'japanese-human-retrieval' + path.sep)) throw new Error('Refusing non-frozen MIRACL database.');
if (fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing audit result.');
const representatives = fs.readFileSync(representativesPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) as Array<{id:string;group_id:string;query:string;gold_ids:string[]}>;
const original = fs.readFileSync(checkpointPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) as Array<{qid:string;group_id:string;query:string;gold_ids:string[];arms:Record<'0'|'0.2',{top10:string[];hit10:boolean;hit50:boolean;error:string|null}>}>;
const frozenSummaryPath=path.join(path.dirname(checkpointPath),'miracl-holdout-api-20261022.summary.json');
const frozenSummary=JSON.parse(fs.readFileSync(frozenSummaryPath,'utf8')) as {articleCount:number};
if (representatives.length !== 726 || original.length !== 726) throw new Error('Frozen holdout/checkpoint must each contain exactly 726 rows.');
if (frozenSummary.articleCount!==6_953_614) throw new Error('Frozen evaluation summary has an unexpected corpus count.');
for (let i=0;i<representatives.length;i++) {
  const a=representatives[i]!,b=original[i]!;
  if (a.id!==b.qid||a.group_id!==b.group_id||a.query!==b.query||JSON.stringify(a.gold_ids)!==JSON.stringify(b.gold_ids)) throw new Error('Frozen checkpoint mismatch at row '+i);
}

process.env.DB_PATH=databasePath;
process.env.NODE_ENV='test';
process.env.SITE_SYNC='off';
process.env.ARTICLE_SEARCH_ENGINE='fts5-title-rerank';
process.env.SEARCH_READ_ONLY_AUDIT='1';
delete process.env.API_KEY;
const [{app},requestModule,{db}]=await Promise.all([import('../../app.js'),import('supertest'),import('../../db/database.js')]);
const request=requestModule.default;
const corpusCount=frozenSummary.articleCount;
const options={dedupThreshold:1,archiveScoreThreshold:-1,resultLimit:50};
const filters={excludedTerms:[],sources:[],status:'all'};
const configBase={label:'MIRACL prior-run evaluator audit',description:'',k1:1.8,b:0.8,lambda:0.02,contextBonus:2.2,keywords:[]};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
const fd=fs.openSync(outputPath,'wx');
const results:Array<Record<string,unknown>>=[];
const auditStartedAt=performance.now();
console.log(JSON.stringify({phase:'API ready',corpusCount,queries:representatives.length,outputPath}));
const percentile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]??0;};
try {
  for(let index=0;index<representatives.length;index++) {
    const row=representatives[index]!;
    const parsed=await request(app).post('/api/search/terms').send({text:row.query}).timeout({response:120_000,deadline:150_000});
    if(parsed.status!==200||!Array.isArray(parsed.body?.keywords)) throw new Error('Parser failed at '+row.id+': HTTP '+parsed.status);
    const arms:Record<'0'|'0.2',Record<string,unknown>>={} as Record<'0'|'0.2',Record<string,unknown>>;
    const order:Array<'0'|'0.2'>=index%2?['0.2','0']:['0','0.2'];
    for(const key of order) {
      process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT=key;
      const started=performance.now();
      const response=await request(app).post('/api/run').send({modeId:'custom',config:{...configBase,keywords:parsed.body.keywords},options,filters}).timeout({response:120_000,deadline:150_000});
      if(response.status!==200||!Array.isArray(response.body?.active)) throw new Error('Search failed at '+row.id+', weight='+key+': HTTP '+response.status);
      const top=(response.body.active as Array<{article?:{id?:string}}>).slice(0,50).map(item=>item.article?.id).filter((id):id is string=>typeof id==='string').map(id=>id.replace(/^miracl-ja-/,''));
      if(top.length!==Math.min(50,response.body.active.length)) throw new Error('Malformed result list at '+row.id);
      const relevant=new Set(row.gold_ids);
      const first=top.findIndex(id=>relevant.has(id));
      const hit10=top.slice(0,10).some(id=>relevant.has(id));
      const hit50=top.some(id=>relevant.has(id));
      const old=original[index]!.arms[key];
      arms[key]={weight:Number(key),latencyMs:performance.now()-started,returnedCount:response.body.active.length,scope:response.body.scope,stats:response.body.stats,
        top50:top,positiveQrelCount:relevant.size,hit10,hit50,firstRelevantRank:first<0?null:first+1,
        agreesWithFrozen:{hit10:hit10===old.hit10,hit50:hit50===old.hit50,top10:JSON.stringify(top.slice(0,10))===JSON.stringify(old.top10)},
        original:{hit10:old.hit10,hit50:old.hit50},error:null};
    }
    const auditRow={qid:row.id,group_id:row.group_id,query:row.query,gold_ids:row.gold_ids,arms};
    results.push(auditRow);
    fs.writeSync(fd,JSON.stringify(auditRow)+'\n');
    if((index+1)%25===0||index+1===representatives.length) {
      fs.fsyncSync(fd);
      console.log(JSON.stringify({completed:index+1,total:representatives.length,elapsedMinutes:Number(((performance.now()-auditStartedAt)/60000).toFixed(1))}));
    }
  }
} finally { fs.closeSync(fd); db.close(); }
const summarize=(arm:'0'|'0.2')=>{
  const rows=results.map(row=>(row.arms as Record<string,Record<string,unknown>>)[arm]!);
  return {returnedCount:{min:Math.min(...rows.map(row=>Number(row.returnedCount))),median:percentile(rows.map(row=>Number(row.returnedCount)),.5),max:Math.max(...rows.map(row=>Number(row.returnedCount)))},
    hit10:rows.filter(row=>row.hit10).length,hit50:rows.filter(row=>row.hit50).length,
    hitFlagsAgree:rows.filter(row=>(row.agreesWithFrozen as Record<string,boolean>).hit10&&(row.agreesWithFrozen as Record<string,boolean>).hit50).length,
    top10ExactlyMatches:rows.filter(row=>(row.agreesWithFrozen as Record<string,boolean>).top10).length,
    p50Ms:percentile(rows.map(row=>Number(row.latencyMs)),.5),p95Ms:percentile(rows.map(row=>Number(row.latencyMs)),.95)};
};
const summary={audit:'post-hoc evaluator/API audit only; the consumed holdout is not retuning or independent validation',queryCount:results.length,candidateCorpusCount:corpusCount,
  arms:{baseline:summarize('0'),candidate:summarize('0.2')},resultLimit:50,
  apiTopKImplementation:'routes/search_routes.ts caps title-reranked active results at requestedResultLimit; returnedCount is captured directly from response.body.active.length',
  readOnly:'SEARCH_READ_ONLY_AUDIT=1 suppresses only candidate ranking metadata updates; it does not alter tokens, candidates, ordering, filters, or response shape'};
fs.writeFileSync(outputPath+'.summary.json',JSON.stringify(summary,null,2),{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify(summary,null,2));
