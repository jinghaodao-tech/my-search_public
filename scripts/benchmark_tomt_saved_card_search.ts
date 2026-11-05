import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {buildStoredTokenSet} from '../bm25_engine.js';
import type {Card} from '../domain/card.js';

type TomtDocument = {id:string;title:string;body:string;source?:string};
type TomtQuery = {id:string;query:string;gold_ids:string[];group_id:string;split:string};
type SearchItem = {article?:{id?:string}};
type ArmResult = {rank:number|null;hit1:boolean;hit10:boolean;mrr10:number;ndcg10:number;latencyMs:number;top10:string[];top50:string[];error:string|null};

const [databaseArg, outputArg, ...options] = process.argv.slice(2);
const reuseDatabase = options.includes('--reuse-isolated-db');
const datasetName = options.find(value => value.startsWith('--dataset='))?.split('=')[1] ?? 'books';
const sampleGroupsArg = options.find(value => value.startsWith('--sample-groups='))?.split('=')[1];
const sampleGroups = sampleGroupsArg === undefined ? undefined : Number(sampleGroupsArg);
const sampleOffsetArg = options.find(value => value.startsWith('--sample-offset='))?.split('=')[1];
const sampleOffset = sampleOffsetArg === undefined ? 0 : Number(sampleOffsetArg);
if (!databaseArg || !outputArg) throw new Error('Usage: npx tsx scripts/benchmark_tomt_saved_card_search.ts <new-isolated.sqlite> <new-output.json> [--dataset=books|movies] [--sample-groups=N] [--sample-offset=N] [--reuse-isolated-db]');
if (options.some(value => value !== '--reuse-isolated-db' && !value.startsWith('--dataset=') && !value.startsWith('--sample-groups=') && !value.startsWith('--sample-offset='))) throw new Error('Unknown benchmark option.');
if (!['books','movies'].includes(datasetName) || (sampleGroups !== undefined && (!Number.isInteger(sampleGroups) || sampleGroups < 2)) || !Number.isInteger(sampleOffset) || sampleOffset < 0) throw new Error('Invalid dataset, sample size, or sample offset.');
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (!databasePath.endsWith('.sqlite') || !databasePath.includes(`${path.sep}data${path.sep}`)) throw new Error('Database must be a new .sqlite file under data/.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be under artifacts/.');
if ((!reuseDatabase && fs.existsSync(databasePath)) || (reuseDatabase && !fs.existsSync(databasePath)) || fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing database or output; reuse requires an existing isolated DB.');

const datasetDir = path.resolve(`quality/e2e/data/reddit_tomt/${datasetName}`);
const provenance = JSON.parse(fs.readFileSync(path.join(datasetDir, 'provenance.json'), 'utf8')) as {upstream_zip_sha256:string;documents:number;split_sizes:Record<string,number>};
const readJsonl = <T>(file:string):T[] => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const documents = readJsonl<TomtDocument>(path.join(datasetDir, 'documents.jsonl'));
const allDevelopmentQueries = readJsonl<TomtQuery>(path.join(datasetDir, 'development.jsonl'));
if (documents.length !== provenance.documents || allDevelopmentQueries.length !== provenance.split_sizes.development) throw new Error('Dataset counts do not match the frozen provenance manifest.');
const hash = (value:string) => crypto.createHash('sha256').update(value).digest('hex');
let queries = allDevelopmentQueries;
let querySampling:{method:string;requestedGroups:number;offset:number;selectedGroups:number;selectionSha256:string}|undefined;
if (sampleGroups !== undefined) {
  const groups = new Map<string,TomtQuery[]>();
  for (const row of allDevelopmentQueries) groups.set(row.group_id,[...(groups.get(row.group_id)??[]),row]);
  const selectedGroupIds = [...groups.keys()].sort((a,b)=>hash(a).localeCompare(hash(b))).slice(sampleOffset,sampleOffset+sampleGroups);
  if (selectedGroupIds.length !== sampleGroups) throw new Error(`Requested ${sampleGroups} target groups but only ${selectedGroupIds.length} exist.`);
  queries = selectedGroupIds.map(groupId=>groups.get(groupId)!.sort((a,b)=>hash(`${groupId}\0${a.id}`).localeCompare(hash(`${groupId}\0${b.id}`)))[0]!);
  queries.sort((a,b)=>a.id.localeCompare(b.id));
  querySampling={method:'select target groups by ascending SHA-256(group_id), starting at fixed offset, then one query per group by ascending SHA-256(group_id + NUL + query_id); no ranking or qrel outcome used',requestedGroups:sampleGroups,offset:sampleOffset,selectedGroups:new Set(queries.map(row=>row.group_id)).size,selectionSha256:hash(queries.map(row=>`${row.group_id}\t${row.id}`).join('\n'))};
}
const documentIds = new Set(documents.map(row => row.id));
for (const query of queries) {
  if (query.split !== 'development' || !query.gold_ids.length || query.gold_ids.some(id => !documentIds.has(id))) throw new Error(`Invalid development qrel: ${query.id}`);
}
const uniqueGroups = new Set(queries.map(row => row.group_id));

process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.CARD_SEARCH_ENGINE = 'like';
delete process.env.API_KEY;
const [{app}, requestModule, cardRepository, {db}] = await Promise.all([
  import('../app.js'), import('supertest'), import('../repositories/cards_repository.js'), import('../db/database.js'),
]);
const request = requestModule.default;
const timestamp = '2020-01-01T00:00:00.000Z';
const cards:Card[] = [];
if (!reuseDatabase) {
  for (let index = 0; index < documents.length; index++) {
    const document = documents[index]!;
    const stored = await buildStoredTokenSet(`${document.title} ${document.body}`);
    cards.push({
      id:document.id,title:document.title,body:document.body,summary:undefined,url:undefined,tags:[],links:[],
      type:'article',color:undefined,archived:false,archivedAt:undefined,createdAt:timestamp,updatedAt:timestamp,
      tokens:stored.ngramTokens,docLength:stored.ngramDocLength,...stored,
    });
    if ((index + 1) % 250 === 0 || index + 1 === documents.length) console.log(JSON.stringify({phase:'tokenize',completed:index+1,total:documents.length}));
  }
}
if (reuseDatabase) {
  const existingIds = (db.prepare('SELECT id FROM cards ORDER BY id').all() as Array<{id:string}>).map(row=>row.id);
  const expectedIds = [...documentIds].sort();
  if (existingIds.length !== expectedIds.length || existingIds.some((id,index)=>id!==expectedIds[index])) throw new Error(`Existing isolated database does not contain the exact frozen ${datasetName} document IDs; refusing to reuse it.`);
} else {
  cardRepository.saveCards(cards);
}
const indexStatus = cardRepository.savedCardTokenFtsStatus();
if (!indexStatus.ready || indexStatus.cards !== documents.length) throw new Error(`FTS index preflight failed: ${JSON.stringify(indexStatus)}`);

const modeResponse = await request(app).get('/api/modes');
if (modeResponse.status !== 200 || !modeResponse.body || !Object.keys(modeResponse.body).length) throw new Error('Could not load application search modes.');
const baseMode = Object.values(modeResponse.body)[0] as {description?:string;k1:number;b:number;lambda:number;contextBonus:number};
const engines = ['bm25', 'fts5Rrf', 'fts5Raw', 'fts5Morph', 'e5Rrf'] as const;
type Engine = typeof engines[number];
const outcomes:Record<Engine,ArmResult[]> = {bm25:[],fts5Rrf:[],fts5Raw:[],fts5Morph:[],e5Rrf:[]};
const start = performance.now();
for (let index = 0; index < queries.length; index++) {
  const query = queries[index]!;
  const parsed = await request(app).post('/api/search/terms').send({text:query.query}).timeout({response:30_000,deadline:45_000});
  if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw new Error(`Query parser failed for ${query.id}: HTTP ${parsed.status}`);
  const config = {label:`tomt-${datasetName}-dev-paired-search`,description:baseMode.description ?? '',k1:baseMode.k1,b:baseMode.b,
    lambda:baseMode.lambda,contextBonus:baseMode.contextBonus,keywords:parsed.body.keywords};
  const rotation = index % engines.length;
  const order = [...engines.slice(rotation), ...engines.slice(0, rotation)];
  for (const engine of order) {
    process.env.CARD_SEARCH_ENGINE = engine === 'e5Rrf' ? 'e5-rrf'
      : engine === 'fts5Rrf' ? 'fts5'
        : engine === 'fts5Raw' ? 'fts5-raw'
          : engine === 'fts5Morph' ? 'fts5-morph' : 'like';
    const armStarted = performance.now();
    try {
      const response = await request(app).post('/api/cards/search').send({config,
        options:{dedupThreshold:1,archiveScoreThreshold:0,resultLimit:50},
        filters:{excludedTerms:[],sources:[],status:'all'},
      }).timeout({response:45_000,deadline:60_000});
      if (response.status !== 200 || !Array.isArray(response.body?.active)) throw new Error(`HTTP ${response.status}`);
      const top = (response.body.active as SearchItem[]).slice(0, 50).map(item => item.article?.id).filter((id):id is string => typeof id === 'string');
      const gold = new Set(query.gold_ids);
      const rank = top.findIndex(id => gold.has(id));
      const top10 = top.slice(0,10);
      const dcg = top10.reduce((sum,id,position)=>sum+(gold.has(id)?1/Math.log2(position+2):0),0);
      const ideal = Array.from({length:Math.min(gold.size,10)},(_,position)=>1/Math.log2(position+2)).reduce((sum,value)=>sum+value,0);
      outcomes[engine].push({rank:rank < 0 || rank >= 10 ? null : rank+1,hit1:rank===0,hit10:rank>=0&&rank<10,
        mrr10:rank>=0&&rank<10?1/(rank+1):0,ndcg10:ideal?dcg/ideal:0,latencyMs:performance.now()-armStarted,top10,top50:top,error:null});
    } catch (error) {
      outcomes[engine].push({rank:null,hit1:false,hit10:false,mrr10:0,ndcg10:0,latencyMs:performance.now()-armStarted,top10:[],top50:[],error:error instanceof Error?error.message:String(error)});
    }
  }
  if ((index + 1) % 100 === 0 || index + 1 === queries.length) console.log(JSON.stringify({phase:'search',completed:index+1,total:queries.length,elapsedMinutes:Number(((performance.now()-start)/60000).toFixed(1))}));
}

const percentile = (values:number[],p:number) => {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)] ?? 0;
};
const summarize = (rows:ArmResult[]) => ({queries:rows.length,errors:rows.filter(row=>row.error).length,
  hit1:rows.filter(row=>row.hit1).length,hit10:rows.filter(row=>row.hit10).length,
  mrr10:rows.reduce((sum,row)=>sum+row.mrr10,0)/rows.length,ndcg10:rows.reduce((sum,row)=>sum+row.ndcg10,0)/rows.length,
  latencyP50Ms:percentile(rows.map(row=>row.latencyMs),.5),latencyP95Ms:percentile(rows.map(row=>row.latencyMs),.95)});
const pairedHit10 = (candidate:Exclude<Engine,'bm25'>) => {
  let both=0,baselineOnly=0,candidateOnly=0,neither=0;
  const groupRows = new Map<string,Array<{baseline:number;candidate:number}>>();
  for (let index=0;index<queries.length;index++) {
    const baseline=outcomes.bm25[index]!.hit10,candidateHit=outcomes[candidate][index]!.hit10;
    if (baseline&&candidateHit) both++; else if (baseline) baselineOnly++; else if(candidateHit) candidateOnly++; else neither++;
    const group=queries[index]!.group_id;
    const values=groupRows.get(group) ?? [];
    values.push({baseline:Number(baseline),candidate:Number(candidateHit)});
    groupRows.set(group,values);
  }
  let seed=candidate==='fts5Raw'?0x4a13b27d:candidate==='fts5Morph'?0x5b24c38e:candidate==='e5Rrf'?0x6c35d49f:0x2f14c3ad;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
  const groups=[...groupRows.values()];
  const bootstrap:number[]=[];
  for (let iteration=0;iteration<10_000;iteration++) {
    let difference=0,sampledQueries=0;
    for (let draw=0;draw<groups.length;draw++) {
      const group=groups[Math.floor(random()*groups.length)]!;
      difference+=group.reduce((sum,row)=>sum+row.candidate-row.baseline,0);
      sampledQueries+=group.length;
    }
    bootstrap.push(difference/sampledQueries);
  }
  bootstrap.sort((a,b)=>a-b);
  return {both,baselineOnly,candidateOnly,neither,netDifference:(candidateOnly-baselineOnly)/queries.length,
    groupBootstrap95CI:[bootstrap[Math.floor(.025*(bootstrap.length-1))]!,bootstrap[Math.floor(.975*(bootstrap.length-1))]!],
    bootstrapReplicates:bootstrap.length,seed:candidate==='fts5Raw'?'0x4a13b27d':candidate==='fts5Morph'?'0x5b24c38e':candidate==='e5Rrf'?'0x6c35d49f':'0x2f14c3ad'};
};
const databaseFiles=[databasePath,`${databasePath}-wal`,`${databasePath}-shm`]
  .filter(file=>fs.existsSync(file)).map(file=>({file:path.basename(file),bytes:fs.statSync(file).size}));
const result={
  generatedAt:new Date().toISOString(),
  dataset:{name:`Reddit-TOMT ${datasetName[0]!.toUpperCase()}${datasetName.slice(1)}`,split:`development${querySampling?' (hash-selected, one query per target group)':' (exploratory; previously used during search-profile development)'}`,sourceSha256:provenance.upstream_zip_sha256,
    documents:documents.length,queries:queries.length,groups:uniqueGroups.size,queriesSha256:crypto.createHash('sha256').update(queries.map(query=>JSON.stringify(query)).join('\n')).digest('hex'),querySampling,
    documentText:'full available title and description from the downloaded benchmark; not personal saved articles'},
  method:{endpoint:'POST /api/search/terms + POST /api/cards/search',sameParserResponse:true,isolatedDatabase:databasePath,indexStatus,
    databaseReusedWithoutCorpusWrites:reuseDatabase,
    queryOrder:'rotated per-query arm order across five modes',filters:{dedupThreshold:1,archiveScoreThreshold:0,resultLimit:50},
    baseline:'existing application BM25 pipeline over cached morphology and n-gram tokens',
    candidates:{fts5Rrf:'SQLite FTS5 morphological + n-gram + raw title/body/tag ranks fused with RRF(k=60)',fts5Raw:'SQLite FTS5 raw title/body/summary/tags BM25 rank only; Japanese zero-candidate fallback to existing three-signal RRF',fts5Morph:'SQLite FTS5 morphology-token BM25 rank only; zero-candidate fallback to existing three-signal RRF',e5Rrf:'saved-card API E5 reranking of the top max(resultLimit, CARD_SEARCH_E5_CANDIDATES) BM25 candidates, fused by RRF(k=60); local model required'},
    configuration:{cardSearchE5Candidates:process.env.CARD_SEARCH_E5_CANDIDATES ?? '100 (route default)',
      e5VectorCacheLimit:process.env.E5_VECTOR_CACHE_LIMIT ?? '5000 (service default)',baseMode},
    independentValidation:false},
  results:{bm25:summarize(outcomes.bm25),fts5Rrf:summarize(outcomes.fts5Rrf),fts5Raw:summarize(outcomes.fts5Raw),fts5Morph:summarize(outcomes.fts5Morph),e5Rrf:summarize(outcomes.e5Rrf),
    pairedHit10:{fts5Rrf:pairedHit10('fts5Rrf'),fts5Raw:pairedHit10('fts5Raw'),fts5Morph:pairedHit10('fts5Morph'),e5Rrf:pairedHit10('e5Rrf')}},
  resources:{isolatedDatabaseFiles:databaseFiles,isolatedDatabaseTotalBytes:databaseFiles.reduce((sum,file)=>sum+file.bytes,0),processRssBytes:process.memoryUsage().rss,processHeapUsedBytes:process.memoryUsage().heapUsed,
    memoryMeasurement:'same process after both arms; not per-engine increment'},
  perQuery:queries.map((query,index)=>({id:query.id,group_id:query.group_id,query:query.query,gold_ids:query.gold_ids,bm25:outcomes.bm25[index],fts5Rrf:outcomes.fts5Rrf[index],fts5Raw:outcomes.fts5Raw[index],fts5Morph:outcomes.fts5Morph[index],e5Rrf:outcomes.e5Rrf[index]})),
  limits:`Development partition is exploratory and contains ${datasetName}-recollection tasks rather than article refinding. This is not an independent final test or product-wide quality claim.`,
};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({outputPath,results:result.results,resources:result.resources,dataset:result.dataset},null,2));
db.close();
