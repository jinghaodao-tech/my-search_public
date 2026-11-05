import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { buildStoredTokenSet, runPipeline, type Article } from '../bm25_engine.js';
import { parseSearchQuery } from '../search/query_parser.js';
import { rerankByTitleCoverage } from '../services/title_rerank.js';
import { rerankWithE5Rrf } from '../services/e5_rrf_ranker.js';

type QueryCase = { id: string; query: string; expected: string[]; querySet: string };
type Doc = Article & { morphologicalTokens: string[]; ngramTokens: string[] };
const root = process.cwd();
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/anonymized-corpus.json'), 'utf8')) as { documents: Array<Record<string, unknown>> };
const queries = [
  { file: 'real-queries.json', rows: JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/real-queries.json'), 'utf8')) as Array<Omit<QueryCase, 'querySet'>> },
  { file: 'real-queries-v2.json', rows: JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/real-queries-v2.json'), 'utf8')) as Array<Omit<QueryCase, 'querySet'>> },
].flatMap(({ file, rows }) => rows.map(row => ({ ...row, querySet: file })));
const corpus = fixture.documents.map(row => ({
  id: String(row.id), title: String(row.title), body: String(row.body), url: String(row.url),
  sourceAuthority: Number(row.sourceAuthority ?? 0.8), publishedAt: new Date(String(row.publishedAt)),
  tokens: row.tokens as string[], docLength: Number(row.docLength ?? (row.tokens as string[]).length),
  morphologicalTokens: (row.morphologicalTokens as string[] | undefined) ?? row.tokens as string[],
  ngramTokens: (row.ngramTokens as string[] | undefined) ?? row.tokens as string[],
  morphologicalDocLength: Number(row.morphologicalDocLength ?? (row.morphologicalTokens as string[] | undefined)?.length ?? (row.tokens as string[]).length),
  ngramDocLength: Number(row.ngramDocLength ?? (row.ngramTokens as string[] | undefined)?.length ?? (row.tokens as string[]).length),
} satisfies Doc));
const byId = new Map(corpus.map(doc => [doc.id, doc]));
const semanticProxyArticle = (article: Article): Article => ({
  ...article,
  title: '',
  summary: '',
  tags: [],
  body: (article.morphologicalTokens ?? article.tokens ?? []).join(' '),
});
const dbPath = path.join(os.tmpdir(), `my-search-article-fts-benchmark-${process.pid}.sqlite`);
fs.rmSync(dbPath, { force: true });
const db = new Database(dbPath);
db.exec(`CREATE VIRTUAL TABLE article_search USING fts5(id UNINDEXED,morph,ngram);
  CREATE VIRTUAL TABLE article_morph USING fts5(id UNINDEXED,tokens);
  CREATE VIRTUAL TABLE article_ngram USING fts5(id UNINDEXED,tokens);`);
const insert = db.prepare('INSERT INTO article_search(id,morph,ngram) VALUES(?,?,?)');
const insertMorph = db.prepare('INSERT INTO article_morph(id,tokens) VALUES(?,?)');
const insertNgram = db.prepare('INSERT INTO article_ngram(id,tokens) VALUES(?,?)');
const indexStarted = performance.now();
db.transaction(() => {
  for (const doc of corpus) {
    const morph = doc.morphologicalTokens.join(' ');
    const ngram = doc.ngramTokens.join(' ');
    insert.run(doc.id, morph, ngram);
    insertMorph.run(doc.id, morph);
    insertNgram.run(doc.id, ngram);
  }
})();
const indexBuildMs = performance.now() - indexStarted;
const page = db.pragma('page_size', { simple: true }) as number;
const pages = db.pragma('page_count', { simple: true }) as number;
const indexSizeBytes = page * pages;
const quoteTerms = (tokens: string[]) => [...new Set(tokens.filter(Boolean))].map(token => `"${token.replace(/"/g, '""')}"`);
const ftsExpression = (column: string, tokens: string[]) => quoteTerms(tokens).map(term => `${column} : ${term}`).join(' OR ');
const plainExpression = (tokens: string[]) => quoteTerms(tokens).join(' OR ');
const morphSearch = db.prepare('SELECT id,bm25(article_morph) score FROM article_morph WHERE article_morph MATCH ? ORDER BY score,id');
const ngramSearch = db.prepare('SELECT id,bm25(article_ngram) score FROM article_ngram WHERE article_ngram MATCH ? ORDER BY score,id');
const standardSearch = db.prepare('SELECT id,bm25(article_search) score FROM article_search WHERE article_search MATCH ? ORDER BY score,id');
const modeFor = (keywords: Array<{term:string;weight:number;synonyms:string[]}>) => ({ label:'engine-eval',description:'same 50 manual queries',k1:1.5,b:0.75,lambda:0.085,contextBonus:1.2,morphologicalWeight:0.3,ngramWeight:0.7,keywords });
const synonymMap = { bm25: ['ranking'], token: ['tokens_json'], csv: ['json'], validation: ['validate'] };
const latencies: Record<string, number[]> = { existing: [], bm25E5Rrf: [], bm25E5WeightedRrf: [], bm25E5ExactGuard: [], fts5: [], rrf: [], fts5Rerank: [], titleMorph: [], title01: [], title02: [], fts5MorphE5ScoreBlend75: [], fts5MorphE5ScoreBlend90: [], queryTokenization: [] };
const outputs: Record<string, string[][]> = { existing: [], bm25E5Rrf: [], bm25E5WeightedRrf: [], bm25E5ExactGuard: [], fts5: [], rrf: [], fts5Rerank: [], titleMorph: [], title01: [], title02: [], fts5MorphE5ScoreBlend75: [], fts5MorphE5ScoreBlend90: [] };
const exactGuardUsed: boolean[] = [];
const RRF_K = 60;
let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
const memorySampler = setInterval(() => {
  const usage = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, usage.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
}, 20);

function metrics(rankings: string[][], queryIndices = queries.map((_, index) => index)) {
  let p1=0, rPrecision=0, mrr10=0, recall100=0, ndcg10=0, map100=0;
  queryIndices.forEach(index => {
    const query = queries[index]!;
    const ranked = rankings[index] ?? [];
    const relevant = new Set(query.expected);
    p1 += Number(!!ranked[0] && relevant.has(ranked[0]));
    const rHits = ranked.slice(0, relevant.size).filter(id => relevant.has(id)).length;
    rPrecision += rHits / Math.max(relevant.size, 1);
    const hits10 = ranked.slice(0, 10).filter(id => relevant.has(id));
    mrr10 += (ranked.slice(0,10).findIndex(id => relevant.has(id)) + 1) > 0 ? 1/(ranked.slice(0,10).findIndex(id => relevant.has(id)) + 1) : 0;
    recall100 += ranked.slice(0,100).filter(id => relevant.has(id)).length / Math.max(relevant.size,1);
    let dcg = 0; ranked.slice(0,10).forEach((id, rank) => { if (relevant.has(id)) dcg += 1 / Math.log2(rank + 2); });
    const ideal = Array.from({length: Math.min(relevant.size,10)}, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum,value)=>sum+value,0);
    ndcg10 += ideal ? dcg / ideal : 0;
    let hits=0, ap=0; ranked.slice(0,100).forEach((id,rank) => { if (relevant.has(id)) { hits++; ap += hits/(rank+1); } });
    map100 += ap/Math.max(relevant.size,1);
  });
  const n=queryIndices.length;
  return Object.fromEntries(Object.entries({precisionAt1:p1/n,rPrecision:rPrecision/n,mrrAt10:mrr10/n,recallAt100:recall100/n,ndcgAt10:ndcg10/n,mapAt100:map100/n}).map(([key,value])=>[key,Number(value.toFixed(4))]));
}
function queryTokens(query: QueryCase) {
  const parsed = parseSearchQuery(query.query, synonymMap);
  const keywords = parsed.parsedKeywords;
  return { parsed, keywords, mode: modeFor(keywords) };
}
function rankedRows(rows: Array<{id:string}>) { return rows.map(row => row.id); }
function percentile(values: number[], p: number) {
  const sorted=[...values].sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)] ?? 0;
}
function ndcg10(ranked: string[], expected: string[]): number {
  const relevant = new Set(expected);
  let dcg = 0;
  ranked.slice(0, 10).forEach((id, rank) => { if (relevant.has(id)) dcg += 1 / Math.log2(rank + 2); });
  const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
  return ideal ? dcg / ideal : 0;
}
function pairedClusterBootstrap(baseline: string[][], candidate: string[][], cases: QueryCase[]) {
  const parent = cases.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const join = (left: number, right: number) => { const a = find(left); const b = find(right); if (a !== b) parent[b] = a; };
  const owner = new Map<string, number>();
  cases.forEach((query, index) => query.expected.forEach(id => {
    const previous = owner.get(id);
    if (previous === undefined) owner.set(id, index);
    else join(index, previous);
  }));
  const grouped = new Map<number, number[]>();
  cases.forEach((_, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), index]);
  });
  const clusters = [...grouped.values()];
  const delta = cases.map((query, index) => ndcg10(candidate[index] ?? [], query.expected) - ndcg10(baseline[index] ?? [], query.expected));
  const meanDelta = delta.reduce((sum, value) => sum + value, 0) / Math.max(delta.length, 1);
  let state = 0x6d2b79f5;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const samples: number[] = [];
  for (let sample = 0; sample < 20000; sample++) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      for (const index of cluster) { sum += delta[index]!; count++; }
    }
    samples.push(sum / Math.max(count, 1));
  }
  return { meanDelta, ci95: [percentile(samples, 0.025), percentile(samples, 0.975)], clusterCount: clusters.length, bootstrapSamples: samples.length };
}
async function main() {
  for (const query of queries) {
    const { parsed, keywords, mode } = queryTokens(query);
    let start = performance.now();
    const base = await runPipeline(corpus, mode, 'benchmark-existing', {dedupThreshold:1,archiveScoreThreshold:-1,resultLimit:100});
    const bm25Latency = performance.now()-start;
    latencies.existing.push(bm25Latency);
    outputs.existing.push(base.active.map(item=>item.article.id));

    const allTerms = parsed.parsedKeywords.flatMap(item => [item.term,...item.synonyms]);
    const exactGuardStarted = performance.now();
    const primaryMorphs = (await buildStoredTokenSet(parsed.parsedKeywords.map(item => item.term).join(' '))).morphologicalTokens;
    const firstBm25Article = base.active[0]?.article;
    const protectsExactTop = primaryMorphs.length > 0 && primaryMorphs.every(term => firstBm25Article?.morphologicalTokens?.includes(term));
    exactGuardUsed.push(protectsExactTop);
    if (protectsExactTop) {
      outputs.bm25E5ExactGuard.push(base.active.map(item=>item.article.id));
    } else {
      const guardedE5 = await rerankWithE5Rrf(base.active.slice(0, 100).map(row => ({ ...row, article: semanticProxyArticle(row.article) })), allTerms.join(' '));
      outputs.bm25E5ExactGuard.push(guardedE5.map(row=>row.item.article.id));
    }
    latencies.bm25E5ExactGuard.push(bm25Latency + performance.now() - exactGuardStarted);
    const e5Started = performance.now();
    const e5Ranked = await rerankWithE5Rrf(base.active.slice(0, 100).map(row => ({ ...row, article: semanticProxyArticle(row.article) })), allTerms.join(' '));
    outputs.bm25E5Rrf.push(e5Ranked.map(row => row.item.article.id));
    latencies.bm25E5Rrf.push(bm25Latency + performance.now() - e5Started);
    const weightedStarted = performance.now();
    outputs.bm25E5WeightedRrf.push(e5Ranked
      .map(row => ({ row, score: 0.5 / (60 + row.bm25Rank) + 1 / (60 + row.e5Rank) }))
      .sort((left, right) => right.score - left.score || left.row.bm25Rank - right.row.bm25Rank || left.row.item.article.id.localeCompare(right.row.item.article.id))
      .map(({ row }) => row.item.article.id));
    latencies.bm25E5WeightedRrf.push(bm25Latency + performance.now() - weightedStarted);

    start=performance.now();
    const qTokenStart=performance.now();
    const qTokens = await buildStoredTokenSet(allTerms.join(' '));
    const queryTokenizationMs=performance.now()-qTokenStart;
    latencies.queryTokenization.push(queryTokenizationMs);
    const morphExpr=plainExpression(qTokens.morphologicalTokens);
    const ngramExpr=plainExpression(qTokens.ngramTokens);
    const combined=[ftsExpression('morph',qTokens.morphologicalTokens),ftsExpression('ngram',qTokens.ngramTokens)].filter(Boolean).join(' OR ');
    const standard=combined ? rankedRows(standardSearch.all(combined) as Array<{id:string}>) : [];
    latencies.fts5.push(performance.now()-start);
    outputs.fts5.push(standard);

    start=performance.now();
    const morphRows=morphExpr ? morphSearch.all(morphExpr) as Array<{id:string;score:number}> : [];
    const morph=rankedRows(morphRows);
    const ngram= ngramExpr ? rankedRows(ngramSearch.all(ngramExpr) as Array<{id:string}>) : [];
    const blendStarted=start;
    const morphCandidates=morphRows.slice(0,100).flatMap(row=>{const article=byId.get(row.id);return article?[{article:semanticProxyArticle(article),score:-row.score}]:[];});
    if (morphCandidates.length) {
      const semanticRows=await rerankWithE5Rrf(morphCandidates,allTerms.join(' '));
      const semanticById=new Map(semanticRows.map(row=>[row.item.article.id,row.similarity]));
      const bm25Scores=morphCandidates.map(row=>row.score);
      const semanticScores=morphCandidates.map(row=>semanticById.get(row.article.id) ?? 0);
      const normalize=(values:number[])=>{
        const min=Math.min(...values),max=Math.max(...values),range=max-min;
        return values.map(value=>range>0?(value-min)/range:0);
      };
      const lexical=normalize(bm25Scores), semantic=normalize(semanticScores);
      for (const variant of [{key:'fts5MorphE5ScoreBlend75',weight:0.75},{key:'fts5MorphE5ScoreBlend90',weight:0.9}]) {
        const top=morphCandidates.map((row,index)=>({id:row.article.id,score:variant.weight*lexical[index]!+(1-variant.weight)*semantic[index]!}))
          .sort((left,right)=>right.score-left.score||left.id.localeCompare(right.id)).map(row=>row.id);
        const topIds=new Set(top);
        outputs[variant.key]!.push([...top,...morph.filter(id=>!topIds.has(id))]);
        latencies[variant.key]!.push(queryTokenizationMs+performance.now()-blendStarted);
      }
    } else {
      outputs.fts5MorphE5ScoreBlend75.push([]);
      outputs.fts5MorphE5ScoreBlend90.push([]);
      latencies.fts5MorphE5ScoreBlend75.push(queryTokenizationMs+performance.now()-blendStarted);
      latencies.fts5MorphE5ScoreBlend90.push(queryTokenizationMs+performance.now()-blendStarted);
    }
    const titleStarted=performance.now();
    const titleRows=morphExpr ? morphSearch.all(morphExpr) as Array<{id:string;score:number}> : [];
    const titleCandidates=titleRows.slice(0,1000).flatMap(row=>{const doc=byId.get(row.id);return doc?[{article:doc,score:-row.score}]:[];});
    const titleSearchMs=performance.now()-titleStarted;
    const titleVariants=[
      { key:'titleMorph', weight:0 },
      { key:'title01', weight:0.1 },
      { key:'title02', weight:0.2 },
    ] as const;
    for (const variant of titleVariants) {
      const rerankStarted=performance.now();
      const ranked=rerankByTitleCoverage(titleCandidates,qTokens.morphologicalTokens,variant.weight);
      outputs[variant.key]!.push(ranked.map(item=>item.article.id));
      latencies[variant.key]!.push(queryTokenizationMs+titleSearchMs+performance.now()-rerankStarted);
    }
    const rrf=new Map<string,number>();
    morph.forEach((id,rank)=>rrf.set(id,(rrf.get(id)??0)+1/(RRF_K+rank+1)));
    ngram.forEach((id,rank)=>rrf.set(id,(rrf.get(id)??0)+1/(RRF_K+rank+1)));
    outputs.rrf.push([...rrf].sort((a,b)=>b[1]-a[1]).map(([id])=>id));
    latencies.rrf.push(performance.now()-start+queryTokenizationMs);

    start=performance.now();
    const candidates=[...new Set([...morph,...ngram])].flatMap(id=>{const doc=byId.get(id);return doc?[doc]:[];});
    const reranked=await runPipeline(candidates,mode,'benchmark-fts-candidate-rerank',{dedupThreshold:1,archiveScoreThreshold:-1,resultLimit:100});
    latencies.fts5Rerank.push(performance.now()-start+queryTokenizationMs);
    outputs.fts5Rerank.push(reranked.active.map(item=>item.article.id));
  }
  const rss=process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, rss.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, rss.heapUsed);
  const candidateRecall = queries.filter((query, index) => outputs.existing[index]!.some(id => query.expected.includes(id))).length / queries.length;
  const pairedVsExisting = Object.fromEntries(Object.entries(outputs)
    .filter(([method]) => method !== 'existing')
    .map(([method, rankings]) => [method, pairedClusterBootstrap(outputs.existing, rankings, queries)]));
  const pairedVsStandardFts5 = Object.fromEntries(Object.entries(outputs)
    .filter(([method]) => method !== 'fts5')
    .map(([method, rankings]) => [method, pairedClusterBootstrap(outputs.fts5, rankings, queries)]));
  const e5Paired = pairedVsExisting.bm25E5Rrf!;
  const querySetIndices = Object.fromEntries([...new Set(queries.map(query => query.querySet))]
    .map(querySet => [querySet, queries.flatMap((query, index) => query.querySet === querySet ? [index] : [])]));
  const querySetMetrics = Object.fromEntries(Object.entries(querySetIndices).map(([querySet, indices]) => [querySet,
    Object.fromEntries(Object.entries(outputs).map(([method, rankings]) => [method, metrics(rankings, indices)])),
  ]));
  const perQuery = queries.map((query, index) => {
    const rank = (rows: string[]) => {
      const position = rows.findIndex(id => query.expected.includes(id));
      return position < 0 ? null : position + 1;
    };
    return {
      queryId: query.id,
      querySet: query.querySet,
      expectedIds: query.expected,
      exactTopTermsPreserved: exactGuardUsed[index],
      ranks: Object.fromEntries(Object.entries(outputs).map(([method, rankings]) => [method, rank(rankings[index]!)])),
      relevantRanks: Object.fromEntries(Object.entries(outputs).map(([method, rankings]) => [method,
        query.expected.map(id => rankings[index]!.indexOf(id)).filter(position => position >= 0).map(position => position + 1),
      ])),
      candidateHit: rank(outputs.existing[index]!) !== null,
    };
  });
  const report={ generatedAt:new Date().toISOString(),dataset:{name:'anonymized-card-corpus-v2-manual-queries',documents:corpus.length,queries:queries.length,labelSource:'manual relevance labels',limitations:'Exploratory: this small hand-labeled corpus and these queries were used in prior comparisons; not a fresh holdout, not BEIR/MIRACL, and not evidence of large-corpus latency. Raw article text is unavailable; E5 uses the retained morphology token sequence as a content proxy.'},model:{id:'Xenova/multilingual-e5-small',quantization:'q8',runtime:'Transformers.js / ONNX Runtime CPU',documentText:'retained morphologicalTokens joined as pseudo-body; placeholder title/body excluded',candidateDepth:100,rrfK:60},methods:{
    existing:{metrics:metrics(outputs.existing),latencyMs:{p50:Number(percentile(latencies.existing,.5).toFixed(3)),p95:Number(percentile(latencies.existing,.95).toFixed(3))}},
    bm25E5Rrf:{metrics:metrics(outputs.bm25E5Rrf),latencyMs:{p50:Number(percentile(latencies.bm25E5Rrf,.5).toFixed(3)),p95:Number(percentile(latencies.bm25E5Rrf,.95).toFixed(3)),firstRequestTotal:Number(latencies.bm25E5Rrf[0]!.toFixed(3)),warmP50:Number(percentile(latencies.bm25E5Rrf.slice(1),.5).toFixed(3)),warmP95:Number(percentile(latencies.bm25E5Rrf.slice(1),.95).toFixed(3))},candidateRecall,pairedNdcg10DifferenceVsBm25:e5Paired},
    bm25E5WeightedRrf:{metrics:metrics(outputs.bm25E5WeightedRrf),latencyMs:{p50:Number(percentile(latencies.bm25E5WeightedRrf,.5).toFixed(3)),p95:Number(percentile(latencies.bm25E5WeightedRrf,.95).toFixed(3))},weights:{bm25:0.5,e5:1},weightSelectedOn:'FiQA development nDCG@10; fixed before this diagnostic; not tuned on these card queries',candidateRecall,pairedNdcg10DifferenceVsExisting:pairedVsExisting.bm25E5WeightedRrf,pairedNdcg10DifferenceVsStandardFts5:pairedVsStandardFts5.bm25E5WeightedRrf},
    bm25E5ExactGuard:{metrics:metrics(outputs.bm25E5ExactGuard),latencyMs:{p50:Number(percentile(latencies.bm25E5ExactGuard,.5).toFixed(3)),p95:Number(percentile(latencies.bm25E5ExactGuard,.95).toFixed(3))},gate:{rule:'If BM25 rank 1 contains every distinct morphology token derived from original query terms, retain the full BM25 ordering; otherwise apply E5-RRF to BM25 Top-100.',preservedQueryCount:exactGuardUsed.filter(Boolean).length,rerankedQueryCount:exactGuardUsed.filter(value=>!value).length},pairedNdcg10DifferenceVsBm25:pairedVsExisting.bm25E5ExactGuard},
    fts5:{metrics:metrics(outputs.fts5),latencyMs:{p50:Number(percentile(latencies.fts5,.5).toFixed(3)),p95:Number(percentile(latencies.fts5,.95).toFixed(3))},pairedNdcg10DifferenceVsExisting:pairedVsExisting.fts5,rankingDefinition:'SQLite FTS5 BM25(k1=1.2,b=0.75 defaults), one index with separate morphology/ngram columns; union-style MATCH expression'},
    rrf:{metrics:metrics(outputs.rrf),latencyMs:{p50:Number(percentile(latencies.rrf,.5).toFixed(3)),p95:Number(percentile(latencies.rrf,.95).toFixed(3)),k:RRF_K},pairedNdcg10DifferenceVsExisting:pairedVsExisting.rrf,pairedNdcg10DifferenceVsStandardFts5:pairedVsStandardFts5.rrf},
    fts5Rerank:{metrics:metrics(outputs.fts5Rerank),latencyMs:{p50:Number(percentile(latencies.fts5Rerank,.5).toFixed(3)),p95:Number(percentile(latencies.fts5Rerank,.95).toFixed(3))},pairedNdcg10DifferenceVsExisting:pairedVsExisting.fts5Rerank},
    fts5MorphE5ScoreBlend75:{metrics:metrics(outputs.fts5MorphE5ScoreBlend75),latencyMs:{p50:Number(percentile(latencies.fts5MorphE5ScoreBlend75,.5).toFixed(3)),p95:Number(percentile(latencies.fts5MorphE5ScoreBlend75,.95).toFixed(3))},pairedNdcg10DifferenceVsStandardFts5Morph:pairedClusterBootstrap(outputs.titleMorph,outputs.fts5MorphE5ScoreBlend75,queries),definition:'Within morphology-FTS5 top 100; query-local min-max normalized inverted FTS5 BM25 and E5 cosine; 0.75 lexical + 0.25 semantic; remaining morphology results retain their order.'},
    fts5MorphE5ScoreBlend90:{metrics:metrics(outputs.fts5MorphE5ScoreBlend90),latencyMs:{p50:Number(percentile(latencies.fts5MorphE5ScoreBlend90,.5).toFixed(3)),p95:Number(percentile(latencies.fts5MorphE5ScoreBlend90,.95).toFixed(3))},pairedNdcg10DifferenceVsStandardFts5Morph:pairedClusterBootstrap(outputs.titleMorph,outputs.fts5MorphE5ScoreBlend90,queries),definition:'Within morphology-FTS5 top 100; query-local min-max normalized inverted FTS5 BM25 and E5 cosine; 0.90 lexical + 0.10 semantic; remaining morphology results retain their order.'},
    fts5MorphTop1000:{metrics:metrics(outputs.titleMorph),latencyMs:{p50:Number(percentile(latencies.titleMorph,.5).toFixed(3)),p95:Number(percentile(latencies.titleMorph,.95).toFixed(3))},candidatePolicy:'production route fts5-title-rerank; morphology-only FTS5 top 1000; title weight 0',pairedNdcg10DifferenceVsExisting:pairedVsExisting.titleMorph,pairedNdcg10DifferenceVsStandardFts5:pairedVsStandardFts5.titleMorph},
    fts5TitleCoverage01:{metrics:metrics(outputs.title01),latencyMs:{p50:Number(percentile(latencies.title01,.5).toFixed(3)),p95:Number(percentile(latencies.title01,.95).toFixed(3))},candidatePolicy:'same morphology-only FTS5 top 1000; title coverage weight 0.1',pairedNdcg10DifferenceVsExisting:pairedVsExisting.title01},
    fts5TitleCoverage02:{metrics:metrics(outputs.title02),latencyMs:{p50:Number(percentile(latencies.title02,.5).toFixed(3)),p95:Number(percentile(latencies.title02,.95).toFixed(3))},candidatePolicy:'same morphology-only FTS5 top 1000; title coverage weight 0.2',pairedNdcg10DifferenceVsExisting:pairedVsExisting.title02},
  },index:{buildMs:Number(indexBuildMs.toFixed(3)),sizeBytes:indexSizeBytes},memory:{rssBytes:rss.rss,heapUsedBytes:rss.heapUsed,peakRssBytes,peakHeapUsedBytes:peakHeapUsedBytes,scope:'peak sampled every 20ms during evaluation process; includes the loaded E5 model, embedding cache, FTS indexes, and fixture'}, perQuery, querySetMetrics,
    queryTokenizationMs:{p50:Number(percentile(latencies.queryTokenization,.5).toFixed(3)),p95:Number(percentile(latencies.queryTokenization,.95).toFixed(3))},
    notes:['BM25+E5 RRF uses the same BM25 Top-100 candidates as the opt-in saved-card API route; no E5 candidate outside that set can be recovered.','Raw article title/body text was removed by anonymization. All E5 reranking variants in this run embed the retained morphology tokens, excluding generic placeholder title/body so the semantic model receives article-derived information. This token bag omits original word order and is a proxy, not a production-text run.','BM25+E5 timing includes BM25 pipeline, model load on the first query, query/doc embedding, and RRF. HTTP serialization and DB load are excluded.','BM25 and E5+RRF use the application query parser terms; the E5 query string is the parsed term/synonym list sent by the UI.','Paired nDCG confidence interval resamples connected query clusters sharing expected documents, but remains exploratory because the query set was reused in prior comparisons.','FTS5 and the other existing methods retain their prior benchmark definitions.','This 50-query manual corpus is diagnostic only and is not large enough for a general quality claim.'],
    statisticalComparison:{primaryMetric:'nDCG@10',unit:'connected components of queries sharing any expected document',...e5Paired},
  };
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const output=path.join(root,'artifacts',`article-search-engine-comparison-${stamp}.json`);
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,report},null,2));
}
try { await main(); } finally { clearInterval(memorySampler); db.close(); fs.rmSync(dbPath,{force:true}); }
