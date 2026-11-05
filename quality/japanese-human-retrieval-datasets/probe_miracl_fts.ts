import fs from 'node:fs';
import path from 'node:path';

const [databaseArg, developmentFileArg, sampleCountArg = '20', outputArg, engineArg = 'fts5-rrf'] = process.argv.slice(2);
if (!databaseArg || !developmentFileArg) {
  throw new Error('Usage: probe_miracl_fts.ts <isolated.sqlite> <development.jsonl> [sample-count]');
}
const databasePath = path.resolve(databaseArg);
const developmentFile = path.resolve(developmentFileArg);
const runAll = sampleCountArg.toLowerCase() === 'all';
const sampleCount = runAll ? undefined : Number.parseInt(sampleCountArg, 10);
if (!runAll && (!Number.isSafeInteger(sampleCount) || sampleCount! < 1)) throw new Error('sample-count must be positive or all');
process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.ARTICLE_SEARCH_ENGINE = engineArg;
delete process.env.API_KEY;

const queries = fs.readFileSync(developmentFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
const selected = runAll
  ? queries
  : Array.from({ length: Math.min(sampleCount!, queries.length) }, (_, index) =>
    queries[Math.floor(index * queries.length / Math.min(sampleCount!, queries.length))]);
const [{ app }, requestModule, { db }] = await Promise.all([
  import('../../app.js'),
  import('supertest'),
  import('../../db/database.js'),
]);
const request = requestModule.default;
const { buildStoredTokenSet } = await import('../../bm25_engine.js');
const { articleSearchIndexStatus } = await import('../../repositories/articles_repository.js');
const configBase = {
  label: 'MIRACL FTS pilot theory',
  description: 'Isolated development-only route load probe',
  k1: 1.8,
  b: 0.8,
  lambda: 0.02,
  contextBonus: 2.2,
  keywords: [],
};
const options = { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 50 };
const filters = { excludedTerms: [], sources: [], status: 'all' };
const outcomes = [];
const started = performance.now();
let maxHeapUsedBytes = process.memoryUsage().heapUsed;
const collectCandidateDiagnostics = process.env.PROBE_CANDIDATE_DIAGNOSTICS === '1';
const includeFullIndexStatus = process.env.PROBE_INCLUDE_FULL_INDEX_STATUS === '1';
const progress = (detail: Record<string, unknown>) => {
  if (process.env.PROBE_PROGRESS === '1') console.log(JSON.stringify(detail));
};

try {
  for (const [queryIndex, query] of selected.entries()) {
    const queryStarted = performance.now();
    let uiLatencyMs = 0;
    let parsedResponse;
    progress({stage: 'query-start', completed: queryIndex, total: selected.length, qid: query.id});
    try {
      const parserStarted = performance.now();
      try {
        parsedResponse = await request(app).post('/api/search/terms').send({ text: query.query }).timeout({ response: 30000, deadline: 60000 });
      } finally { uiLatencyMs += performance.now() - parserStarted; }
      progress({stage: 'parser-complete', qid: query.id, elapsedMs: uiLatencyMs});
      if (parsedResponse.status !== 200) throw new Error(`query parser returned ${parsedResponse.status}`);
      const config = { ...configBase, keywords: parsedResponse.body.keywords };
      const queryTokenSet = await buildStoredTokenSet(config.keywords.map((item: { term: string }) => item.term).join(' '));
      const matchExpression = (tokens: string[]) => [...new Set(tokens)].map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
      const countMatches = (table: string, expression: string) => expression
        ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(expression) as { n: number }).n)
        : 0;
      const morphMatches = collectCandidateDiagnostics ? countMatches('articles_morph_fts', matchExpression(queryTokenSet.morphologicalTokens)) : null;
      const ngramMatches = collectCandidateDiagnostics ? countMatches('articles_ngram_fts', matchExpression(queryTokenSet.ngramTokens)) : null;
      const parsedTerms = parsedResponse.body.keywords.map((item: { term: string }) => item.term) as string[];
      const goldArticleIds = query.gold_ids.map((id: string) => `miracl-ja-${id}`);
      const goldPlaceholders = goldArticleIds.map(() => '?').join(',');
      const goldDocuments = db.prepare(`SELECT id,title,body FROM articles WHERE id IN (${goldPlaceholders})`)
        .all(...goldArticleIds) as Array<{id:string;title:string;body:string}>;
      const normalizedGoldText = goldDocuments.map(item => `${item.title} ${item.body}`.normalize('NFKC').toLocaleLowerCase('ja-JP'));
      const matchedParsedTerms = [...new Set(parsedTerms)].filter(term => {
        const normalized = term.normalize('NFKC').toLocaleLowerCase('ja-JP');
        return normalized && normalizedGoldText.some(text => text.includes(normalized));
      });
      const matchingGoldIds = (table: string, expression: string) => collectCandidateDiagnostics && expression
        ? (db.prepare(`SELECT id FROM ${table} WHERE ${table} MATCH ? AND id IN (${goldPlaceholders})`).all(expression, ...goldArticleIds) as Array<{id:string}>).map(row => row.id.replace(/^miracl-ja-/, ''))
        : null;
      const goldInMorphCandidates = matchingGoldIds('articles_morph_fts', matchExpression(queryTokenSet.morphologicalTokens));
      const goldInNgramCandidates = matchingGoldIds('articles_ngram_fts', matchExpression(queryTokenSet.ngramTokens));
      const runStarted = performance.now();
      let resultResponse;
      try {
        progress({stage: 'api-start', qid: query.id, diagnosticElapsedMs: performance.now() - queryStarted});
        resultResponse = await request(app).post('/api/run').send({ modeId: 'custom', config, options, filters })
          .timeout({ response: 30000, deadline: 60000 });
      } finally { uiLatencyMs += performance.now() - runStarted; }
      progress({stage: 'search-complete', qid: query.id, elapsedMs: performance.now() - runStarted});
      if (resultResponse.status !== 200) throw new Error(`search API returned ${resultResponse.status} for ${query.id}`);
      const body = resultResponse.body;
      const rankedIds = body.active.map((item: { article: { id: string } }) => item.article.id.replace(/^miracl-ja-/, ''));
      const relevant = new Set(query.gold_ids);
      const firstRelevant = rankedIds.findIndex((id: string) => relevant.has(id));
      const dcg10 = rankedIds.slice(0, 10).reduce((sum: number, id: string, index: number) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
      const ideal10 = Array.from({ length: Math.min(relevant.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
      outcomes.push({
        qid: query.id,
        groupId: query.group_id,
        group_id: query.group_id,
        query: query.query,
        gold_ids: query.gold_ids,
        expected: query.gold_ids,
        parsedTerms,
        goldDocumentsFound: goldDocuments.length,
        goldDocumentCount: query.gold_ids.length,
        goldMatchedParsedTerms: matchedParsedTerms,
        goldParsedTermCoverage: parsedTerms.length ? matchedParsedTerms.length / new Set(parsedTerms).size : 0,
        goldInMorphCandidates,
        goldInNgramCandidates,
        morphologyTokenCount: queryTokenSet.morphologicalTokens.length,
        ngramTokenCount: queryTokenSet.ngramTokens.length,
        morphologyMatchCount: morphMatches,
        ngramMatchCount: ngramMatches,
        searchMethod: body.scope.searchMethod,
        candidateCount: body.scope.candidateCount,
        retrievedCandidateCount: body.scope.retrievedCandidateCount,
        searchedCount: body.scope.searchedCount,
        returnedCount: rankedIds.length,
        top10: body.active.slice(0, 10).map((item: {article:{id:string};score:number;scoreSources?:unknown}) => ({id:item.article.id.replace(/^miracl-ja-/, ''),score:item.score,scoreSources:item.scoreSources ?? null})),
        firstRelevantRank: firstRelevant >= 0 ? firstRelevant + 1 : null,
        hit1: firstRelevant === 0,
        hit10: firstRelevant >= 0 && firstRelevant < 10,
        hit50: firstRelevant >= 0 && firstRelevant < 50,
        reciprocalRank10: firstRelevant >= 0 && firstRelevant < 10 ? 1 / (firstRelevant + 1) : 0,
        ndcg10: ideal10 > 0 ? dcg10 / ideal10 : 0,
        latencyMs: uiLatencyMs,
        diagnosticElapsedMs: performance.now() - queryStarted,
        error: null,
      });
    } catch (error) {
      progress({stage: 'query-error', qid: query.id, message: error instanceof Error ? error.message : String(error)});
      outcomes.push({
        qid: query.id, groupId: query.group_id, group_id: query.group_id, query: query.query,
        gold_ids: query.gold_ids, expected: query.gold_ids,
        firstRelevantRank: null, hit1: false, hit10: false, hit50: false,
        reciprocalRank10: 0, ndcg10: 0, latencyMs: uiLatencyMs, diagnosticElapsedMs: performance.now() - queryStarted,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    maxHeapUsedBytes = Math.max(maxHeapUsedBytes, process.memoryUsage().heapUsed);
    if ((queryIndex + 1) % 50 === 0) console.log(JSON.stringify({completed:queryIndex+1,total:selected.length,elapsedSeconds:Math.round((performance.now()-started)/1000),currentLatencyMs:outcomes.at(-1)!.latencyMs,rssBytes:process.memoryUsage().rss}));
  }
  const sorted = outcomes.map(item => item.latencyMs).sort((a, b) => a - b);
  const diagnosticsSorted = outcomes.map(item => item.diagnosticElapsedMs).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  const diagnosticPercentile = (p: number) => diagnosticsSorted[Math.min(diagnosticsSorted.length - 1, Math.ceil(diagnosticsSorted.length * p) - 1)];
  const result = {
    dataset: 'MIRACL Japanese; development-only API evaluation',
    engine: engineArg,
    mode: 'theory',
    databasePath,
    sourceDocumentCount: includeFullIndexStatus ? db.prepare('SELECT COUNT(*) AS n FROM articles').get() : null,
    ftsStatus: includeFullIndexStatus ? db.prepare('SELECT (SELECT COUNT(*) FROM articles_morph_fts) AS morph, (SELECT COUNT(*) FROM articles_ngram_fts) AS ngram').get() : null,
    apiIndexStatus: includeFullIndexStatus ? articleSearchIndexStatus() : null,
    missingTokenSamples: db.prepare("SELECT id, length(title) AS titleLength, length(body) AS bodyLength, substr(title,1,80) AS title, substr(body,1,100) AS body, morphological_tokens_json, ngram_tokens_json FROM articles WHERE COALESCE(morphological_tokens_json,'[]')='[]' OR COALESCE(ngram_tokens_json,tokens_json,'[]')='[]' LIMIT 5").all(),
    sampledQueryCount: outcomes.length,
    errors: outcomes.filter(item => item.error).length,
    metrics: {
      hitAt1: outcomes.filter(item => item.hit1).length / outcomes.length,
      hitAt10: outcomes.filter(item => item.hit10).length / outcomes.length,
      hitAt50: outcomes.filter(item => item.hit50).length / outcomes.length,
      mrr10: outcomes.reduce((sum, item) => sum + item.reciprocalRank10, 0) / outcomes.length,
      ndcg10: outcomes.reduce((sum, item) => sum + item.ndcg10, 0) / outcomes.length,
    },
    latency: {
      uiApiP50Ms: percentile(0.5), uiApiP95Ms: percentile(0.95),
      diagnosticElapsedP50Ms: diagnosticPercentile(0.5), diagnosticElapsedP95Ms: diagnosticPercentile(0.95),
      totalMs: performance.now() - started,
    },
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    maxObservedHeapUsedBytes: maxHeapUsedBytes,
    outcomes,
    results: outcomes,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputArg) fs.writeFileSync(path.resolve(outputArg), output, 'utf8');
  console.log(output);
} finally {
  db.close();
}
