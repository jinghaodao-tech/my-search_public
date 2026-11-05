import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [databaseArg, queriesArg, sampleArg = 'all', outputArg] = process.argv.slice(2);
if (!databaseArg || !queriesArg) throw new Error('Usage: evaluate_miracl_app_rrf.ts <isolated.sqlite> <split.jsonl> [all|sample-count] [output.json]');
const databasePath = path.resolve(databaseArg);
const queryPath = path.resolve(queriesArg);
const sampleCount = sampleArg.toLowerCase() === 'all' ? undefined : Number.parseInt(sampleArg, 10);
if (sampleCount !== undefined && (!Number.isSafeInteger(sampleCount) || sampleCount < 1)) throw new Error('sample-count must be positive or all');
process.env.DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
delete process.env.API_KEY;

interface QueryRecord { id: string; group_id: string; query: string; gold_ids: string[] }
const records: QueryRecord[] = [];
for await (const line of readline.createInterface({ input: fs.createReadStream(queryPath), crlfDelay: Infinity })) {
  if (line.trim()) records.push(JSON.parse(line) as QueryRecord);
}
const selected = sampleCount === undefined
  ? records
  : Array.from({ length: Math.min(sampleCount, records.length) }, (_, index) => records[Math.floor(index * records.length / Math.min(sampleCount, records.length))]);
const [{ db }, { purposeWords, purposeTermWeight }, { analyzeQuery }, { buildStoredTokenSet }, { searchArticleIdsFts5Rrf }] = await Promise.all([
  import('../../db/database.js'),
  import('../../services/discover_service.js'),
  import('../../services/query_analysis.js'),
  import('../../bm25_engine.js'),
  import('../../repositories/articles_repository.js'),
]);
const outcomes = [];
const started = performance.now();
let maxObservedHeapUsedBytes = process.memoryUsage().heapUsed;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};

try {
  for (const [index, record] of selected.entries()) {
    const queryStarted = performance.now();
    let parserLatencyMs = 0;
    let tokenPreparationLatencyMs = 0;
    let rankingLatencyMs = 0;
    try {
      const parserStarted = performance.now();
      const spaced = record.query.split(/\s+/).filter(Boolean);
      const words = await purposeWords(record.query);
      const parsed = analyzeQuery(record.query, words.length ? words : spaced, term => purposeTermWeight(term) === 3 ? 1.5 : 1);
      parserLatencyMs = performance.now() - parserStarted;
      const keywords = parsed.keywords.map(item => item.term);
      const tokenStarted = performance.now();
      const queryTokens = await buildStoredTokenSet(keywords.join(' '));
      tokenPreparationLatencyMs = performance.now() - tokenStarted;
      const rankingStarted = performance.now();
      const search = searchArticleIdsFts5Rrf(queryTokens.morphologicalTokens, queryTokens.ngramTokens, 50);
      rankingLatencyMs = performance.now() - rankingStarted;
      const ids = search.ranks.map(row => row.id.replace(/^miracl-ja-/, ''));
      const gold = new Set(record.gold_ids);
      const rankIndex = ids.findIndex(id => gold.has(id));
      const rank = rankIndex < 0 ? null : rankIndex + 1;
      const dcg = ids.slice(0, 10).reduce((sum, id, position) => sum + (gold.has(id) ? 1 / Math.log2(position + 2) : 0), 0);
      const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, position) => 1 / Math.log2(position + 2)).reduce((sum, value) => sum + value, 0);
      outcomes.push({
        qid: record.id, groupId: record.group_id, group_id: record.group_id, query: record.query,
        parsedTerms: keywords, gold_ids: record.gold_ids, expected: record.gold_ids,
        candidateCount: search.matchedCount, returnedCount: ids.length,
        rankTop10: rank !== null && rank <= 10 ? rank : null,
        rankTop50: rank !== null && rank <= 50 ? rank : null,
        rankTop100: rank !== null && rank <= 100 ? rank : null,
        rankTop1000: rank !== null && rank <= 1000 ? rank : null,
        hit1: rank === 1, hit10: rank !== null && rank <= 10,
        hit50: rank !== null && rank <= 50, hit100: rank !== null && rank <= 100,
        hit1000: rank !== null && rank <= 1000,
        reciprocalRank10: rank !== null && rank <= 10 ? 1 / rank : 0,
        ndcg10: ideal ? dcg / ideal : 0, top10: ids.slice(0, 10),
        latencyMs: performance.now() - queryStarted, parserLatencyMs, tokenPreparationLatencyMs, rankingLatencyMs, error: null,
      });
    } catch (error) {
      outcomes.push({
        qid: record.id, groupId: record.group_id, group_id: record.group_id, query: record.query,
        gold_ids: record.gold_ids, expected: record.gold_ids,
        candidateCount: 0, returnedCount: 0, rankTop10: null, rankTop50: null, rankTop100: null, rankTop1000: null,
        hit1: false, hit10: false, hit50: false, hit100: false, hit1000: false,
        reciprocalRank10: 0, ndcg10: 0, top10: [], latencyMs: performance.now() - queryStarted,
        parserLatencyMs, tokenPreparationLatencyMs, rankingLatencyMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    maxObservedHeapUsedBytes = Math.max(maxObservedHeapUsedBytes, process.memoryUsage().heapUsed);
    if ((index + 1) % 10 === 0) console.log(JSON.stringify({ completed: index + 1, total: selected.length, elapsedSeconds: Math.round((performance.now() - started) / 1000), rssBytes: process.memoryUsage().rss }));
  }
  const latencies = outcomes.map(row => row.latencyMs);
  const result = {
    dataset: 'MIRACL Japanese; my-search production SQLite FTS5 RRF retrieval function',
    ranking: 'searchArticleIdsFts5Rrf() exact full-modality ranks, RRF k=60; no network/API, no runPipeline rerank; top 50 candidate limit as the production endpoint default',
    queryAnalysis: 'same purposeWords(), purposeTermWeight(), and analyzeQuery() functions as POST /api/search/terms, called in-process because loopback API requests are blocked in this runtime',
    databasePath, queryCount: outcomes.length, errorCount: outcomes.filter(row => row.error).length,
    metrics: {
      hit1: outcomes.filter(row => row.hit1).length / outcomes.length,
      hit10: outcomes.filter(row => row.hit10).length / outcomes.length,
      hit50: outcomes.filter(row => row.hit50).length / outcomes.length,
      mrr10: outcomes.reduce((sum, row) => sum + row.reciprocalRank10, 0) / outcomes.length,
      ndcg10: outcomes.reduce((sum, row) => sum + row.ndcg10, 0) / outcomes.length,
    },
    latency: { p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95), totalMs: performance.now() - started },
    phaseLatencyMs: {
      parserP50: percentile(outcomes.map(row => row.parserLatencyMs), .5), parserP95: percentile(outcomes.map(row => row.parserLatencyMs), .95),
      tokenPreparationP50: percentile(outcomes.map(row => row.tokenPreparationLatencyMs), .5), tokenPreparationP95: percentile(outcomes.map(row => row.tokenPreparationLatencyMs), .95),
      rankingP50: percentile(outcomes.map(row => row.rankingLatencyMs), .5), rankingP95: percentile(outcomes.map(row => row.rankingLatencyMs), .95),
    },
    peakRssBytes: process.resourceUsage().maxRSS * 1024, maxObservedHeapUsedBytes, results: outcomes,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputArg) fs.writeFileSync(path.resolve(outputArg), output, 'utf8');
  console.log(JSON.stringify({ ...result, results: undefined }, null, 2));
} finally {
  db.close();
}
