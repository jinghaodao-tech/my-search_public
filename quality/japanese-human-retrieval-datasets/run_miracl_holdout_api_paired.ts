import fs from 'node:fs';
import path from 'node:path';
import {hitMetrics} from './miracl_metrics.js';

const [databaseArg, representativesArg, outputDirectoryArg, runName = 'miracl-holdout-api-v1', resumeArg] = process.argv.slice(2);
if (!databaseArg || !representativesArg || !outputDirectoryArg) {
  throw new Error('Usage: npm exec tsx -- run_miracl_holdout_api_paired.ts <isolated.sqlite> <enriched-representatives.jsonl> <new-output-dir> [run-name] [--resume]');
}
const databasePath = path.resolve(databaseArg);
if (path.basename(databasePath) !== 'miracl-full-fts.sqlite' || !databasePath.includes(`${path.sep}japanese-human-retrieval${path.sep}`)) {
  throw new Error('Refusing non-isolated database path; expected local_article_corpus/japanese-human-retrieval/miracl-full-fts.sqlite');
}
const outputDirectory = path.resolve(outputDirectoryArg);
fs.mkdirSync(outputDirectory, {recursive: true});
const checkpointPath = path.join(outputDirectory, `${runName}.checkpoint.jsonl`);
const resume = resumeArg === '--resume';
if (resumeArg && !resume) throw new Error('The only optional final argument is --resume');
if (!resume && fs.existsSync(checkpointPath)) throw new Error(`Checkpoint already exists; pass --resume only to continue this frozen run: ${checkpointPath}`);
if (resume && !fs.existsSync(checkpointPath)) throw new Error(`Cannot resume; checkpoint is missing: ${checkpointPath}`);
for (const suffix of ['.baseline.jsonl', '.candidate.jsonl', '.summary.json']) {
  if (fs.existsSync(path.join(outputDirectory, `${runName}${suffix}`))) throw new Error(`Output already exists: ${runName}${suffix}`);
}

const representatives = fs.readFileSync(path.resolve(representativesArg), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (representatives.length !== 726) throw new Error(`Expected 726 representative queries, got ${representatives.length}`);
const ids = new Set<string>();
const groups = new Set<string>();
for (const row of representatives) {
  if (!row.id || !row.group_id || typeof row.query !== 'string' || !row.query.trim() || !Array.isArray(row.gold_ids) || !row.gold_ids.length || ids.has(row.id) || groups.has(row.group_id)) {
    throw new Error(`Invalid or duplicate representative row: ${row.id}`);
  }
  ids.add(row.id);
  groups.add(row.group_id);
}

process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.ARTICLE_SEARCH_ENGINE = 'fts5-title-rerank';
process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT = '0';
delete process.env.API_KEY;
const [{app}, requestModule, {db}] = await Promise.all([
  import('../../app.js'),
  import('supertest'),
  import('../../db/database.js'),
]);
const request = requestModule.default;

const articleCount = Number((db.prepare('SELECT COUNT(*) AS count FROM articles').get() as {count:number}).count);
const morphCount = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_morph_fts').get() as {count:number}).count);
const ngramCount = Number((db.prepare('SELECT COUNT(*) AS count FROM articles_ngram_fts').get() as {count:number}).count);
if (articleCount !== 6_953_614 || morphCount !== articleCount || ngramCount !== articleCount) {
  db.close();
  throw new Error(`Full-corpus preflight failed: articles=${articleCount}, morph=${morphCount}, ngram=${ngramCount}`);
}
const goldIds = [...new Set(representatives.flatMap(row => row.gold_ids as string[]))];
const prefixedGoldIds = goldIds.map(id => `miracl-ja-${id}`);
const found = new Set<string>();
for (let offset = 0; offset < prefixedGoldIds.length; offset += 900) {
  const batch = prefixedGoldIds.slice(offset, offset + 900);
  const placeholders = batch.map(() => '?').join(',');
  const matched = db.prepare(`SELECT id FROM articles WHERE id IN (${placeholders})`).all(...batch) as Array<{id:string}>;
  for (const row of matched) found.add(row.id.replace(/^miracl-ja-/, ''));
}
const missingGoldIds = goldIds.filter(id => !found.has(id));
if (missingGoldIds.length) {
  db.close();
  throw new Error(`Gold documents missing from full corpus: ${missingGoldIds.length}`);
}

const configBase = {label:'MIRACL holdout paired API', description:'', k1:1.8, b:0.8, lambda:0.02, contextBonus:2.2, keywords:[]};
const options = {dedupThreshold:1, archiveScoreThreshold:-1, resultLimit:50};
const filters = {excludedTerms:[], sources:[], status:'all'};
type Arm = {weight:number; latencyMs:number; error:string|null; top10:string[]; hit1:boolean; hit10:boolean; hit50:boolean; rr10:number; ndcg10:number; searchMethod:string|null};
type Checkpoint = {qid:string; group_id:string; query:string; gold_ids:string[]; parserMs:number; parserError:string|null; arms:Record<'0'|'0.2',Arm>};
const readCheckpoint = (): Checkpoint[] => {
  if (!fs.existsSync(checkpointPath)) return [];
  return fs.readFileSync(checkpointPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
};
let completed = readCheckpoint();
if (completed.length > representatives.length || completed.some((row, index) => {
  const expected = representatives[index];
  return row.qid !== expected?.id || row.group_id !== expected?.group_id
    || row.query !== expected?.query
    || JSON.stringify(row.gold_ids) !== JSON.stringify(expected?.gold_ids);
})) {
  db.close();
  throw new Error('Checkpoint is not an exact data-identical prefix of the frozen representative sequence');
}
if (completed.some(row => !row.arms?.['0'] || !row.arms?.['0.2'])) {
  db.close();
  throw new Error('Checkpoint contains incomplete query pairs; refusing ambiguous resume');
}
const resumedPairs = completed.length;

const checkpointFd = fs.openSync(checkpointPath, resume ? 'a' : 'wx');
const startedAt = performance.now();
const percentile = (values:number[], p:number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const failureArm = (weight:number,error:string,latencyMs=0):Arm => ({weight,latencyMs,error,top10:[],hit1:false,hit10:false,hit50:false,rr10:0,ndcg10:0,searchMethod:null});

try {
  for (let index = completed.length; index < representatives.length; index++) {
    const row = representatives[index];
    const parserStarted = performance.now();
    let parsedKeywords:string[] = [];
    let parserError:string|null = null;
    try {
      const parsed = await request(app).post('/api/search/terms').send({text:row.query}).timeout({response:120_000,deadline:150_000});
      if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw new Error(`query parser returned HTTP ${parsed.status}`);
      parsedKeywords = parsed.body.keywords;
    } catch (error) {
      parserError = error instanceof Error ? error.message : String(error);
    }
    const parserMs = performance.now() - parserStarted;
    const arms:Record<'0'|'0.2',Arm> = {} as Record<'0'|'0.2',Arm>;
    for (const weight of (index % 2 ? [0.2,0] : [0,0.2])) {
      const key = String(weight) as '0'|'0.2';
      if (parserError) {
        arms[key] = failureArm(weight, `query parser failure: ${parserError}`);
        continue;
      }
      const requestStarted = performance.now();
      try {
        process.env.ARTICLE_SEARCH_TITLE_RERANK_WEIGHT = String(weight);
        const response = await request(app).post('/api/run').send({modeId:'custom',config:{...configBase,keywords:parsedKeywords},options,filters})
          .timeout({response:120_000,deadline:150_000});
        if (response.status !== 200 || !Array.isArray(response.body?.active)) throw new Error(`search API returned invalid HTTP ${response.status}`);
        const top = response.body.active.slice(0,50).map((item:{article?:{id?:string}})=>item.article?.id).filter((id:unknown):id is string=>typeof id==='string').map((id:string)=>id.replace(/^miracl-ja-/,''));
        if (top.length !== Math.min(50, response.body.active.length) || top.some((id:string)=>!id)) throw new Error('search API returned malformed article IDs');
        const metrics = hitMetrics(top,(row.gold_ids as string[]));
        arms[key] = {weight,latencyMs:performance.now()-requestStarted,error:null,top10:top.slice(0,10),...metrics,searchMethod:response.body.scope?.searchMethod??null};
      } catch (error) {
        arms[key] = failureArm(weight,error instanceof Error?error.message:String(error),performance.now()-requestStarted);
      }
    }
    const checkpoint:Checkpoint = {qid:row.id,group_id:row.group_id,query:row.query,gold_ids:row.gold_ids,parserMs,parserError,arms};
    fs.writeSync(checkpointFd,`${JSON.stringify(checkpoint)}\n`);
    fs.fsyncSync(checkpointFd);
    completed.push(checkpoint);
    if ((index+1)%10===0 || index+1===representatives.length) {
      console.log(JSON.stringify({completed:index+1,total:representatives.length,elapsedSeconds:Math.round((performance.now()-startedAt)/1000),resumedPairs,rssBytes:process.memoryUsage().rss}));
    }
  }
} finally {
  fs.closeSync(checkpointFd);
}

const baselinePath = path.join(outputDirectory,`${runName}.baseline.jsonl`);
const candidatePath = path.join(outputDirectory,`${runName}.candidate.jsonl`);
const summaryPath = path.join(outputDirectory,`${runName}.summary.json`);
for (const output of [baselinePath,candidatePath,summaryPath]) if (fs.existsSync(output)) { db.close(); throw new Error(`Refusing to overwrite ${output}`); }
const writeNew = (file:string, content:string) => fs.writeFileSync(file,content,{encoding:'utf8',flag:'wx'});
const writeArmFile = (weight:'0'|'0.2',file:string) => writeNew(file,`${completed.map(row=>JSON.stringify({qid:row.qid,group_id:row.group_id,hit10:row.arms[weight].hit10,hit1:row.arms[weight].hit1,hit50:row.arms[weight].hit50,rr10:row.arms[weight].rr10,ndcg10:row.arms[weight].ndcg10,error:row.arms[weight].error})).join('\n')}\n`);
writeArmFile('0',baselinePath);
writeArmFile('0.2',candidatePath);
const summaryFor = (weight:'0'|'0.2') => {
  const rows=completed.map(row=>row.arms[weight]);
  return {weight:Number(weight),errors:rows.filter(row=>row.error).length,hit1:rows.filter(row=>row.hit1).length,hit10:rows.filter(row=>row.hit10).length,hit50:rows.filter(row=>row.hit50).length,mrr10:rows.reduce((sum,row)=>sum+row.rr10,0)/rows.length,ndcg10:rows.reduce((sum,row)=>sum+row.ndcg10,0)/rows.length,apiP50Ms:percentile(rows.map(row=>row.latencyMs),.5),apiP95Ms:percentile(rows.map(row=>row.latencyMs),.95)};
};
const candidateById=new Map(completed.map(row=>[row.qid,row.arms['0.2'].hit10&&!row.arms['0.2'].error]));
const baselineById=new Map(completed.map(row=>[row.qid,row.arms['0'].hit10&&!row.arms['0'].error]));
const paired=completed.reduce((counts,row)=>{const a=baselineById.get(row.qid)!,b=candidateById.get(row.qid)!;if(a&&b)counts.both++;else if(a)counts.baselineOnly++;else if(b)counts.candidateOnly++;else counts.neither++;return counts;},{both:0,baselineOnly:0,candidateOnly:0,neither:0});
const summary={dataset:'MIRACL Japanese official full corpus; one-time holdout cluster representatives; API evaluation',runName,queryCount:completed.length,articleCount,morphIndexCount:morphCount,ngramIndexCount:ngramCount,arms:{standardMorphologicalFts5:summaryFor('0'),titleCoverageRerankWeight02:summaryFor('0.2')},pairedHit10:paired,parserErrors:completed.filter(row=>row.parserError).length,parserP50Ms:percentile(completed.map(row=>row.parserMs),.5),parserP95Ms:percentile(completed.map(row=>row.parserMs),.95),peakRssBytes:process.resourceUsage().maxRSS*1024,heapUsedBytes:process.memoryUsage().heapUsed,totalElapsedMs:performance.now()-startedAt,files:{checkpoint:checkpointPath,baseline:baselinePath,candidate:candidatePath}};
writeNew(summaryPath,`${JSON.stringify(summary,null,2)}\n`);
db.close();
console.log(JSON.stringify(summary,null,2));
