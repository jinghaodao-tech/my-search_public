import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const [databaseArg, outputArg] = process.argv.slice(2);
if (!databaseArg || !outputArg) {
  throw new Error('Usage: npx tsx scripts/benchmark_saved_card_search_fts.ts <new-isolated.sqlite> <new-output.json>');
}
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(databasePath) || fs.existsSync(outputPath)) throw new Error('Refusing to overwrite an existing database or output file.');
if (!databasePath.endsWith('.sqlite') || !databasePath.includes(`${path.sep}data${path.sep}`)) throw new Error('The isolated database must be a new .sqlite file under data/.');
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('The output file must be under artifacts/.');

const fixturePath = path.resolve('data/search-evaluation/anonymized-corpus.json');
const queryPath = path.resolve('data/search-evaluation/real-queries-v2.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { version: string; documents: Array<Record<string, unknown>> };
const cases = JSON.parse(fs.readFileSync(queryPath, 'utf8')) as Array<{id:string;query:string;expected:string[]}>;
const ids = new Set(fixture.documents.map(document => String(document.id)));
for (const testCase of cases) {
  if (!testCase.expected.length || testCase.expected.some(id => !ids.has(id))) throw new Error(`Invalid expected IDs for ${testCase.id}`);
}

process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.MOCK_AI_SUMMARY = 'true';
process.env.IMPORT_RATE_LIMIT = '1000';
process.env.CARD_SEARCH_ENGINE = 'like';
delete process.env.API_KEY;
const [{app}, requestModule, cardsRepository, {db}] = await Promise.all([
  import('../app.js'),
  import('supertest'),
  import('../repositories/cards_repository.js'),
  import('../db/database.js'),
]);
const request = requestModule.default;

try {
  const cards = fixture.documents.map((document, index) => {
    const now = new Date(Date.UTC(2020, 0, 1 + index)).toISOString();
    const ngramTokens = Array.isArray(document.tokens) ? document.tokens.map(String) : [];
    const morphologicalTokens = Array.isArray(document.morphologicalTokens) ? document.morphologicalTokens.map(String) : [];
    return {
      id: String(document.id),
      title: String(document.title ?? `匿名カード ${index + 1}`),
      body: ngramTokens.join(' '),
      summary: undefined,
      url: undefined,
      type: 'article' as const,
      color: undefined,
      tags: [] as string[],
      links: [] as string[],
      archived: Boolean(document.archived),
      archivedAt: undefined,
      createdAt: now,
      updatedAt: now,
      tokens: ngramTokens,
      docLength: Number(document.docLength ?? ngramTokens.length),
      morphologicalTokens,
      ngramTokens,
      morphologicalDocLength: morphologicalTokens.length,
      ngramDocLength: ngramTokens.length,
    };
  });
  cardsRepository.saveCards(cards);
  const indexed = Number((db.prepare('SELECT COUNT(*) AS count FROM cards_morph_fts').get() as {count:number}).count);
  const ngramIndexed = Number((db.prepare('SELECT COUNT(*) AS count FROM cards_ngram_fts').get() as {count:number}).count);
  const rawIndexed = Number((db.prepare('SELECT COUNT(*) AS count FROM cards_fts').get() as {count:number}).count);
  if (indexed !== cards.length || ngramIndexed !== cards.length || rawIndexed !== cards.length) {
    throw new Error(`Index preflight failed: cards=${cards.length}, morph=${indexed}, ngram=${ngramIndexed}, raw=${rawIndexed}`);
  }

  type Outcome = {id:string;hit1:boolean;hit10:boolean;rPrecision:number;rr10:number;recall5:number;ndcg5:number;latencyMs:number;returned:number;error:string|null;top10:string[]};
  const outcomes: Record<'bm25'|'fts5Rrf', Outcome[]> = { bm25: [], fts5Rrf: [] };
  for (const [index, testCase] of cases.entries()) {
    const parser = await request(app).post('/api/search/terms').send({text:testCase.query}).timeout({response:30_000,deadline:45_000});
    if (parser.status !== 200 || !Array.isArray(parser.body?.keywords)) throw new Error(`Parser failed for ${testCase.id}: HTTP ${parser.status}`);
    const config = { label:'saved-card-search-comparison', description:'', k1:1.5, b:0.75, lambda:0, contextBonus:1.5, keywords:parser.body.keywords };
    for (const engine of (index % 2 ? ['fts5Rrf','bm25'] : ['bm25','fts5Rrf']) as Array<'bm25'|'fts5Rrf'>) {
      process.env.CARD_SEARCH_ENGINE = engine === 'fts5Rrf' ? 'fts5' : 'like';
      const started = performance.now();
      try {
        const response = await request(app).post('/api/cards/search').send({
          config,
          options:{dedupThreshold:1,archiveScoreThreshold:-1,resultLimit:500},
          filters:{excludedTerms:[],sources:[],status:'all'},
        }).timeout({response:45_000,deadline:60_000});
        if (response.status !== 200 || !Array.isArray(response.body?.active)) throw new Error(`search endpoint returned HTTP ${response.status}`);
        const top: string[] = response.body.active.map((item:{article?:{id?:string}})=>item.article?.id).filter((id:unknown):id is string=>typeof id==='string');
        const relevant = new Set(testCase.expected);
        const first = top.findIndex(id => relevant.has(id));
        const hitCountR = top.slice(0, relevant.size).filter(id => relevant.has(id)).length;
        const dcg = top.slice(0,5).reduce((sum,id,rank)=>sum+(relevant.has(id)?1/Math.log2(rank+2):0),0);
        const ideal = Array.from({length:Math.min(relevant.size,5)},(_,rank)=>1/Math.log2(rank+2)).reduce((sum,value)=>sum+value,0);
        outcomes[engine].push({
          id:testCase.id, hit1:first===0, hit10:first>=0&&first<10,
          rPrecision:relevant.size?hitCountR/relevant.size:0, rr10:first>=0&&first<10?1/(first+1):0,
          recall5:top.slice(0,5).filter(id=>relevant.has(id)).length/relevant.size,
          ndcg5:ideal?dcg/ideal:0, latencyMs:performance.now()-started,
          returned:top.length, error:null, top10:top.slice(0,10),
        });
      } catch (error) {
        outcomes[engine].push({id:testCase.id,hit1:false,hit10:false,rPrecision:0,rr10:0,recall5:0,ndcg5:0,latencyMs:performance.now()-started,returned:0,error:error instanceof Error?error.message:String(error),top10:[]});
      }
    }
  }

  const percentile = (values:number[], p:number) => {
    const sorted=[...values].sort((a,b)=>a-b);
    return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:0;
  };
  const summarize = (rows:Outcome[]) => ({
    queries:rows.length, errors:rows.filter(row=>row.error).length,
    hit1:rows.filter(row=>row.hit1).length/rows.length,
    hit10:rows.filter(row=>row.hit10).length/rows.length,
    rPrecision:rows.reduce((sum,row)=>sum+row.rPrecision,0)/rows.length,
    mrr10:rows.reduce((sum,row)=>sum+row.rr10,0)/rows.length,
    recall5:rows.reduce((sum,row)=>sum+row.recall5,0)/rows.length,
    ndcg5:rows.reduce((sum,row)=>sum+row.ndcg5,0)/rows.length,
    latencyP50Ms:percentile(rows.map(row=>row.latencyMs),.5),
    latencyP95Ms:percentile(rows.map(row=>row.latencyMs),.95),
    returnedP50:percentile(rows.map(row=>row.returned),.5),
  });
  const report = {
    generatedAt:new Date().toISOString(),
    dataset:{version:fixture.version,documents:fixture.documents.length,queries:cases.length,labelSource:'data/search-evaluation/real-queries-v2.json',corpusSource:'anonymized token fixture; article text is not present'},
    evaluation:{purpose:'development comparison of the real POST /api/cards/search endpoint; not an independent holdout or a claim about raw article text',queryParser:'POST /api/search/terms, shared output for both methods',filters:{dedupThreshold:1,archiveScoreThreshold:-1,resultLimit:500},
      metrics:'per-query manual relevance labels; MAP is not calculated; nDCG is @5 and Recall is @5',
      indexes:{cards:cards.length,morphological:indexed,ngram:ngramIndexed,rawFields:rawIndexed}},
    methods:{bm25:summarize(outcomes.bm25),fts5Rrf:summarize(outcomes.fts5Rrf)},
    paired:{improvedHit10:outcomes.bm25.filter((row,i)=>!row.hit10&&outcomes.fts5Rrf[i]!.hit10).length,worsenedHit10:outcomes.bm25.filter((row,i)=>row.hit10&&!outcomes.fts5Rrf[i]!.hit10).length,unchangedHit10:outcomes.bm25.filter((row,i)=>row.hit10===outcomes.fts5Rrf[i]!.hit10).length},
    perQuery:cases.map((testCase,index)=>({id:testCase.id,query:testCase.query,expected:testCase.expected,bm25:outcomes.bm25[index],fts5Rrf:outcomes.fts5Rrf[index]})),
    processMemory:{rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed,measurement:'process-wide at end of both arms; not per-engine incremental RSS'},
  };
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({outputPath,methods:report.methods,paired:report.paired,processMemory:report.processMemory},null,2));
} finally {
  db.close();
}
