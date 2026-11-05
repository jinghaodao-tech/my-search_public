import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [databaseArg, queriesArg, sampleArg = 'all', outputArg] = process.argv.slice(2);
if (!databaseArg || !queriesArg) throw new Error('Usage: benchmark_miracl_title_rerank.ts <isolated.sqlite> <split.jsonl> [all|sample-count] [output.json]');
const databasePath = path.resolve(databaseArg);
const queryPath = path.resolve(queriesArg);
const sampleCount = sampleArg.toLowerCase() === 'all' ? undefined : Number.parseInt(sampleArg, 10);
if (sampleCount !== undefined && (!Number.isSafeInteger(sampleCount) || sampleCount < 1)) throw new Error('sample-count must be positive or all');
const configuredWeight = process.env.MIRACL_TITLE_RERANK_WEIGHT;
const weightLevels = configuredWeight === undefined ? [0, 0.05, 0.1, 0.2, 0.4] : [Number(configuredWeight)];
if (weightLevels.some(weight => !Number.isFinite(weight) || weight < 0)) throw new Error('MIRACL_TITLE_RERANK_WEIGHT must be a finite non-negative number');
process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
delete process.env.API_KEY;

interface QueryRecord { id: string; group_id: string; query: string; gold_ids: string[] }
interface RankedCandidate { id: string; score: number; titleCoverage: number; baselinePosition: number }
const records: QueryRecord[] = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(queryPath), crlfDelay: Infinity })) {
  if (line.trim()) records.push(JSON.parse(line) as QueryRecord);
}
const selected = sampleCount === undefined
  ? records
  : Array.from({ length: Math.min(sampleCount, records.length) }, (_, index) => records[Math.floor(index * records.length / Math.min(sampleCount, records.length))]);
const [{ db }, { purposeWords, purposeTermWeight }, { analyzeQuery }, { buildStoredTokenSet }] = await Promise.all([
  import('../../db/database.js'),
  import('../../services/discover_service.js'),
  import('../../services/query_analysis.js'),
  import('../../bm25_engine.js'),
]);
const fts = db.prepare(`SELECT id,bm25(articles_morph_fts) AS score FROM articles_morph_fts
  WHERE articles_morph_fts MATCH ? ORDER BY score,id LIMIT 1000`);
const outcomes: Array<{qid:string;groupId:string;query:string;gold_ids:string[];byWeight:Record<string,{hit1:boolean;hit10:boolean;rr10:number;ndcg10:number;top10:string[]}>;searchLatencyMs:number;rerankLatencyMs:number;error:string|null}> = [];
const started = performance.now();
const percentile = (values:number[],p:number) => {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];
};

try {
  for (const record of selected) {
    let searchLatencyMs = 0;
    let rerankLatencyMs = 0;
    try {
      const words = await purposeWords(record.query);
      const parsed = analyzeQuery(record.query, words.length ? words : record.query.split(/\s+/).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
      const terms = [...new Set(parsed.keywords.map(item => item.term).map(term => term.normalize('NFKC').toLocaleLowerCase('ja-JP')).filter(Boolean))];
      const tokenSet = await buildStoredTokenSet(terms.join(' '));
      const uniqueTokens = [...new Set(tokenSet.morphologicalTokens)];
      const expression = uniqueTokens.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
      const searchStarted = performance.now();
      const rows = expression ? fts.all(expression) as Array<{id:string;score:number}> : [];
      searchLatencyMs = performance.now() - searchStarted;
      const rerankStarted = performance.now();
      const titles = new Map<string,string>();
      for (let offset=0;offset<rows.length;offset+=400) {
        const batch=rows.slice(offset,offset+400);
        const found=db.prepare(`SELECT id,title FROM articles WHERE id IN (${batch.map(()=>'?').join(',')})`).all(...batch.map(row=>row.id)) as Array<{id:string;title:string}>;
        for(const item of found)titles.set(item.id,item.title??'');
      }
      const candidates: RankedCandidate[] = rows.map((row,index)=>({
        id:row.id.replace(/^miracl-ja-/,''),score:row.score,
        titleCoverage:terms.length?terms.filter(term=>(titles.get(row.id)??'').normalize('NFKC').toLocaleLowerCase('ja-JP').includes(term)).length/terms.length:0,
        baselinePosition:index,
      }));
      rerankLatencyMs = performance.now() - rerankStarted;
      const minScore=Math.min(...candidates.map(item=>item.score));
      const maxScore=Math.max(...candidates.map(item=>item.score));
      const scoreRange=maxScore-minScore||1;
      const normalizedBm25=(score:number)=>(maxScore-score)/scoreRange;
      const gold=new Set(record.gold_ids);
      const byWeight:Record<string,{hit1:boolean;hit10:boolean;rr10:number;ndcg10:number;top10:string[]}>= {};
      for(const weight of weightLevels){
        const sorted=weight===0?candidates:[...candidates].sort((a,b)=>{
          const scoreDiff=normalizedBm25(b.score)-normalizedBm25(a.score)
            +weight*(b.titleCoverage-a.titleCoverage);
          return Math.abs(scoreDiff)>1e-12?scoreDiff:a.baselinePosition-b.baselinePosition;
        });
        const ids=sorted.slice(0,10).map(item=>item.id);
        const first=ids.findIndex(id=>gold.has(id));
        const dcg=ids.reduce((sum,id,index)=>sum+(gold.has(id)?1/Math.log2(index+2):0),0);
        const ideal=Array.from({length:Math.min(gold.size,10)},(_,index)=>1/Math.log2(index+2)).reduce((sum,value)=>sum+value,0);
        byWeight[String(weight)]={hit1:first===0,hit10:first>=0,rr10:first>=0?1/(first+1):0,ndcg10:ideal?dcg/ideal:0,top10:ids};
      }
      outcomes.push({qid:record.id,groupId:record.group_id,query:record.query,gold_ids:record.gold_ids,byWeight,searchLatencyMs,rerankLatencyMs,error:null});
    }catch(error){
      outcomes.push({qid:record.id,groupId:record.group_id,query:record.query,gold_ids:record.gold_ids,byWeight:{},searchLatencyMs,rerankLatencyMs,error:error instanceof Error?error.message:String(error)});
    }
    if (outcomes.length % 50 === 0) console.log(JSON.stringify({ completed: outcomes.length, total: selected.length, elapsedSeconds: Math.round((performance.now() - started) / 1000), rssBytes: process.memoryUsage().rss }));
  }
  const result={
    dataset:'MIRACL Japanese development; full corpus; title lexical rerank prototype',
    method:'Hold morphology BM25 top-1000 candidate set constant. Min-max normalize negative FTS5 BM25 scores to [0,1], then add weight * fraction of parsed query terms found as substrings in the document title. This is an exploratory proxy, not actual user recall.',
    databasePath,queryCount:outcomes.length,errorCount:outcomes.filter(row=>row.error).length,weightLevels,
    metrics:Object.fromEntries(weightLevels.map(weight=>{
      const rows=outcomes.filter(row=>row.byWeight[String(weight)]);
      return [String(weight),{
        hit1:rows.filter(row=>row.byWeight[String(weight)]!.hit1).length/Math.max(1,rows.length),
        hit10:rows.filter(row=>row.byWeight[String(weight)]!.hit10).length/Math.max(1,rows.length),
        mrr10:rows.reduce((sum,row)=>sum+row.byWeight[String(weight)]!.rr10,0)/Math.max(1,rows.length),
        ndcg10:rows.reduce((sum,row)=>sum+row.byWeight[String(weight)]!.ndcg10,0)/Math.max(1,rows.length),
      }];
    })),
    latency:{searchP50Ms:percentile(outcomes.map(row=>row.searchLatencyMs),.5),searchP95Ms:percentile(outcomes.map(row=>row.searchLatencyMs),.95),rerankP50Ms:percentile(outcomes.map(row=>row.rerankLatencyMs),.5),rerankP95Ms:percentile(outcomes.map(row=>row.rerankLatencyMs),.95),totalMs:performance.now()-started},
    peakRssBytes:process.resourceUsage().maxRSS*1024,heapUsedBytes:process.memoryUsage().heapUsed,results:outcomes,
  };
  const serialized=`${JSON.stringify(result,null,2)}\n`;
  if(outputArg)fs.writeFileSync(path.resolve(outputArg),serialized,'utf8');
  console.log(JSON.stringify({...result,results:undefined},null,2));
}finally{db.close();}
