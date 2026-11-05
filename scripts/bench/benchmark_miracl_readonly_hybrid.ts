import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { exactRrfTopK, tieBreakByScore } from './rrf_topk.js';

type Query = { id: string; group_id: string; query: string; gold_ids: string[] };
type Ranked = { id: string; rank: number };
type Outcome = { id: string; groupId: string; baseline: Record<string, number>; hybrid: Record<string, number>; baselineMs: number; hybridMs: number; fallbackUsed: boolean };

const [databaseArg, queriesArg, countArg = 'all', outputArg, strategyArg = 'rrf'] = process.argv.slice(2);
if (!databaseArg || !queriesArg) throw new Error('Usage: benchmark_miracl_readonly_hybrid.ts <isolated.sqlite> <development.jsonl|eval.json> [all|count] [new-output.json|-] [rrf|rrf-pool200|morph-fallback|ngram-only]');
const databasePath = path.resolve(databaseArg);
const queriesPath = path.resolve(queriesArg);
const count = countArg.toLowerCase() === 'all' ? undefined : Number.parseInt(countArg, 10);
if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) throw new Error('count must be a positive integer or all');
if (!['rrf', 'rrf-pool200', 'morph-fallback', 'ngram-only'].includes(strategyArg)) throw new Error('strategy must be rrf, rrf-pool200, morph-fallback, or ngram-only');
const outputPath = outputArg && outputArg !== '-' ? path.resolve(outputArg) : undefined;
if (outputPath && (fs.existsSync(outputPath) || !outputPath.includes(`${path.sep}artifacts${path.sep}`))) throw new Error('Output must be a new file under artifacts/.');

const queryInput = fs.readFileSync(queriesPath, 'utf8');
let queries: Query[];
let documentIdPrefix = 'miracl-ja-';
if (queryInput.trimStart().startsWith('{')) {
  const dataset = JSON.parse(queryInput) as { name?: string; idPrefix?: string; queries: Array<{ id: string; text: string }>; qrels: Record<string, Record<string, number>> };
  documentIdPrefix = dataset.idPrefix ?? '';
  queries = dataset.queries.map(query => ({
    id: query.id,
    group_id: query.id,
    query: query.text,
    gold_ids: Object.entries(dataset.qrels[query.id] ?? {}).filter(([, grade]) => grade > 0).map(([id]) => id),
  }));
} else {
  queries = queryInput.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Query);
}
const selected = count === undefined ? queries : Array.from({ length: Math.min(count, queries.length) }, (_, i) => queries[Math.floor(i * queries.length / Math.min(count, queries.length))]!);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const morph = db.prepare('SELECT id, rank AS score FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank');
const morphRanks = db.prepare('SELECT id, rank AS score FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank');
const ngramRanks = db.prepare('SELECT id, rank AS score FROM articles_ngram_fts WHERE articles_ngram_fts MATCH ? ORDER BY rank');
const morphPool = db.prepare('SELECT id, rank AS score FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank LIMIT 200');
const ngramPool = db.prepare('SELECT id, rank AS score FROM articles_ngram_fts WHERE articles_ngram_fts MATCH ? ORDER BY rank LIMIT 200');
const expression = (tokens: string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))]
  .map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
const score = (ids: string[], goldIds: string[]) => {
  const gold = new Set(goldIds);
  const normalizeId = (id: string) => documentIdPrefix && id.startsWith(documentIdPrefix) ? id.slice(documentIdPrefix.length) : id;
  const first = ids.findIndex(id => gold.has(normalizeId(id)));
  const dcg = ids.slice(0, 10).reduce((sum, id, index) => sum + (gold.has(normalizeId(id)) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return { hit10: Number(first >= 0 && first < 10), mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0 };
};
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const outcomes: Outcome[] = [];
const queryErrors: Array<{ id: string; message: string }> = [];
const started = performance.now();
try {
  for (const [index, query] of selected.entries()) {
    try {
      const words = await purposeWords(query.query);
      const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
      const tokens = await buildStoredTokenSet(parsed.keywords.map(item => item.term).join(' '));
      const morphQuery = expression(tokens.morphologicalTokens);
      const ngramQuery = expression(tokens.ngramTokens);
      const baselineStarted = performance.now();
      const baselineIds = morphQuery
        ? [...tieBreakByScore(morph.iterate(morphQuery) as Iterator<{ id: string; score: number }>)].slice(0, 50).map(row => row.id)
        : [];
      const baselineMs = performance.now() - baselineStarted;
      const hybridStarted = performance.now();
      let hybridIds: string[];
      let fallbackUsed = false;
      if (strategyArg === 'ngram-only') {
        hybridIds = ngramQuery ? [...tieBreakByScore(ngramRanks.iterate(ngramQuery) as Iterator<{ id: string; score: number }>)]
          .slice(0, 50).map(row => row.id) : [];
      } else if (strategyArg === 'morph-fallback') {
        if (baselineIds.length) hybridIds = baselineIds;
        else if (ngramQuery) {
          fallbackUsed = true;
          hybridIds = [...tieBreakByScore(ngramRanks.iterate(ngramQuery) as Iterator<{ id: string; score: number }>)]
            .slice(0, 50).map(row => row.id);
        }
        else hybridIds = [];
      } else if (strategyArg === 'rrf-pool200') {
        const morphRows = morphQuery ? tieBreakByScore(morphPool.iterate(morphQuery) as Iterator<{ id: string; score: number }>) : [][Symbol.iterator]();
        const ngramRows = ngramQuery ? tieBreakByScore(ngramPool.iterate(ngramQuery) as Iterator<{ id: string; score: number }>) : [][Symbol.iterator]();
        hybridIds = exactRrfTopK(morphRows, ngramRows, 50);
      } else {
        const morphCursor = morphQuery ? morphRanks.iterate(morphQuery) as Iterator<{ id: string; score: number }> : [][Symbol.iterator]();
        const ngramCursor = ngramQuery ? ngramRanks.iterate(ngramQuery) as Iterator<{ id: string; score: number }> : [][Symbol.iterator]();
        hybridIds = exactRrfTopK(tieBreakByScore(morphCursor), tieBreakByScore(ngramCursor), 50);
      }
      const hybridMs = performance.now() - hybridStarted + (strategyArg === 'morph-fallback' ? baselineMs : 0);
      outcomes.push({ id: query.id, groupId: query.group_id, baseline: score(baselineIds, query.gold_ids), hybrid: score(hybridIds, query.gold_ids), baselineMs, hybridMs, fallbackUsed });
    } catch (error) {
      queryErrors.push({ id: query.id, message: error instanceof Error ? error.message : String(error) });
    }
    if ((index + 1) % 10 === 0 || index + 1 === selected.length) console.log(JSON.stringify({ completed: index + 1, total: selected.length, elapsedSeconds: Math.round((performance.now() - started) / 1000), errors: queryErrors.length }));
  }
} finally {
  db.close();
}

const metrics = (key: 'baseline' | 'hybrid') => Object.fromEntries((['hit10', 'mrr10', 'ndcg10'] as const).map(metric => [metric,
  outcomes.reduce((sum, row) => sum + row[key][metric], 0) / Math.max(outcomes.length, 1),
]));
let seed = Number.parseInt(crypto.createHash('sha256').update(`${path.basename(queriesPath)}\0miracl-morph-ngram-rrf-k60`).digest('hex').slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const bootstrap = (metric: 'hit10' | 'mrr10' | 'ndcg10') => {
  const groups = new Map<string, number[]>();
  for (const row of outcomes) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row.hybrid[metric] - row.baseline[metric]]);
  const clusters = [...groups.values()];
  const draws = new Array<number>(10_000);
  for (let i = 0; i < draws.length; i++) {
    let total = 0;
    let n = 0;
    for (let j = 0; j < clusters.length; j++) {
      const sample = clusters[Math.floor(random() * clusters.length)]!;
      total += sample.reduce((sum, value) => sum + value, 0);
      n += sample.length;
    }
    draws[i] = n ? total / n : 0;
  }
  draws.sort((a, b) => a - b);
  return { meanDifference: outcomes.reduce((sum, row) => sum + row.hybrid[metric] - row.baseline[metric], 0) / Math.max(outcomes.length, 1), pairedClusterBootstrap95CI: [draws[249]!, draws[9749]!], clusters: clusters.length };
};
const result = {
  purpose: 'Read-only exploratory comparison on MIRACL Japanese official development/validation queries; not a final holdout evaluation.',
  dataset: { input: path.basename(queriesPath), idPrefix: documentIdPrefix, selectedQueries: selected.length, evaluatedQueries: outcomes.length, errors: queryErrors.length, dbPath: databasePath, queryInputSha256: crypto.createHash('sha256').update(queryInput).digest('hex') },
  fallback: { enabled: strategyArg === 'morph-fallback', queriesUsed: outcomes.filter(row => row.fallbackUsed).length },
  ranking: {
    baseline: 'SQLite FTS5 built-in BM25 over the morphology token index; same parser, query, and 50-result limit.',
    hybrid: strategyArg === 'rrf'
      ? 'Equal RRF k=60 over complete morphology FTS5 and n-gram FTS5 BM25 rank lists; top 50 returned.'
      : strategyArg === 'rrf-pool200'
        ? 'Approximate equal RRF k=60 over the top 200 candidates from each morphology FTS5 and n-gram FTS5 BM25 list; top 50 returned. Candidates below either pool cutoff are omitted.'
      : strategyArg === 'ngram-only'
        ? 'SQLite FTS5 built-in BM25 over the n-gram token index; same parser and 50-result limit.'
        : 'Use morphology FTS5 BM25 unless it returns zero candidates, then use n-gram FTS5 BM25; top 50 returned.',
    databaseAccess: 'better-sqlite3 readonly=true; no app database module, migrations, or writes.',
  },
  metrics: { baseline: metrics('baseline'), hybrid: metrics('hybrid'), differences: Object.fromEntries((['hit10', 'mrr10', 'ndcg10'] as const).map(metric => [metric, bootstrap(metric)])) },
  latencyMs: { baselineP50: percentile(outcomes.map(row => row.baselineMs), .5), baselineP95: percentile(outcomes.map(row => row.baselineMs), .95), hybridP50: percentile(outcomes.map(row => row.hybridMs), .5), hybridP95: percentile(outcomes.map(row => row.hybridMs), .95) },
  resources: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, elapsedMs: performance.now() - started },
  queryErrors,
  perQuery: outcomes,
};
if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath ?? null, dataset: result.dataset, fallback: result.fallback, ranking: result.ranking, metrics: result.metrics, latencyMs: result.latencyMs, resources: result.resources }, null, 2));
