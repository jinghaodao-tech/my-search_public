import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { buildStoredTokenSet, runPipeline, type Article } from '../../bm25_engine.js';
import { parseSearchQuery } from '../../search/query_parser.js';

type QueryCase = { id: string; query: string; expected: string[]; querySet: string };
type Document = Article & { morphologicalTokens: string[]; ngramTokens: string[] };
const root = process.cwd();
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/anonymized-corpus.json'), 'utf8')) as { documents: Array<Record<string, unknown>> };
const queries: QueryCase[] = [
  { file: 'real-queries.json', rows: JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/real-queries.json'), 'utf8')) as Array<Omit<QueryCase, 'querySet'>> },
  { file: 'real-queries-v2.json', rows: JSON.parse(fs.readFileSync(path.join(root, 'data/search-evaluation/real-queries-v2.json'), 'utf8')) as Array<Omit<QueryCase, 'querySet'>> },
].flatMap(({ file, rows }) => rows.map(row => ({ ...row, querySet: file })));
const documents = fixture.documents.map(row => ({
  id: String(row.id), title: String(row.title), body: String(row.body), url: String(row.url),
  sourceAuthority: Number(row.sourceAuthority ?? 0.8), publishedAt: new Date(String(row.publishedAt)),
  tokens: row.tokens as string[], docLength: Number(row.docLength ?? (row.tokens as string[]).length),
  morphologicalTokens: (row.morphologicalTokens as string[] | undefined) ?? row.tokens as string[],
  ngramTokens: (row.ngramTokens as string[] | undefined) ?? row.tokens as string[],
} satisfies Document));
const dbPath = path.join(os.tmpdir(), `my-search-card-morph-fts-${process.pid}.sqlite`);
const db = new Database(dbPath);
db.exec('CREATE VIRTUAL TABLE article_morph USING fts5(id UNINDEXED,tokens); CREATE VIRTUAL TABLE article_search USING fts5(id UNINDEXED,morph,ngram);');
const insert = db.prepare('INSERT INTO article_morph(id,tokens) VALUES(?,?)');
const insertCombined = db.prepare('INSERT INTO article_search(id,morph,ngram) VALUES(?,?,?)');
const indexStart = performance.now();
db.transaction(() => {
  for (const document of documents) {
    insert.run(document.id, document.morphologicalTokens.join(' '));
    insertCombined.run(document.id, document.morphologicalTokens.join(' '), document.ngramTokens.join(' '));
  }
})();
const indexBuildMs = performance.now() - indexStart;
const pageSize = db.pragma('page_size', { simple: true }) as number;
const indexSizeBytes = pageSize * (db.pragma('page_count', { simple: true }) as number);
const combinedSearch = db.prepare('SELECT id FROM article_search WHERE article_search MATCH ? ORDER BY bm25(article_search),id LIMIT 1000');
const corpusById = new Map(documents.map(document => [document.id, document]));
const synonymMap = { bm25: ['ranking'], token: ['tokens_json'], csv: ['json'], validation: ['validate'] };
const baselineRankings: string[][] = [];
const ftsRankings: string[][] = [];
const combinedRankings: string[][] = [];
const baselineMs: number[] = [];
const ftsMs: number[] = [];
const combinedMs: number[] = [];
const candidateHits: boolean[] = [];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function metrics(rankings: string[][], indices = queries.map((_, index) => index)) {
  let hit1 = 0, hit10 = 0, mrr10 = 0, ndcg10 = 0, recall100 = 0, map100 = 0;
  for (const index of indices) {
    const query = queries[index]!;
    const ranked = rankings[index] ?? [];
    const relevant = new Set(query.expected);
    hit1 += Number(!!ranked[0] && relevant.has(ranked[0]));
    hit10 += Number(ranked.slice(0, 10).some(id => relevant.has(id)));
    const first = ranked.slice(0, 10).findIndex(id => relevant.has(id));
    if (first >= 0) mrr10 += 1 / (first + 1);
    let dcg = 0;
    ranked.slice(0, 10).forEach((id, rank) => { if (relevant.has(id)) dcg += 1 / Math.log2(rank + 2); });
    const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
    ndcg10 += ideal ? dcg / ideal : 0;
    recall100 += ranked.slice(0, 100).filter(id => relevant.has(id)).length / Math.max(relevant.size, 1);
    let hits = 0, ap = 0;
    ranked.slice(0, 100).forEach((id, rank) => { if (relevant.has(id)) { hits++; ap += hits / (rank + 1); } });
    map100 += ap / Math.max(relevant.size, 1);
  }
  const n = Math.max(indices.length, 1);
  return { hitAt1: hit1 / n, hitAt10: hit10 / n, mrrAt10: mrr10 / n, ndcgAt10: ndcg10 / n, recallAt100: recall100 / n, mapAt100: map100 / n };
}

function ndcg(ranking: string[], expected: string[]) {
  const relevant = new Set(expected);
  let dcg = 0;
  ranking.slice(0, 10).forEach((id, rank) => { if (relevant.has(id)) dcg += 1 / Math.log2(rank + 2); });
  const ideal = Array.from({ length: Math.min(relevant.size, 10) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((sum, value) => sum + value, 0);
  return ideal ? dcg / ideal : 0;
}

function pairedClusterBootstrap(baseline: string[][], candidate: string[][]) {
  const parent = queries.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const join = (left: number, right: number) => { const a = find(left), b = find(right); if (a !== b) parent[b] = a; };
  const owner = new Map<string, number>();
  queries.forEach((query, index) => query.expected.forEach(id => {
    const previous = owner.get(id);
    if (previous === undefined) owner.set(id, index);
    else join(index, previous);
  }));
  const grouped = new Map<number, number[]>();
  queries.forEach((_, index) => {
    const representative = find(index);
    grouped.set(representative, [...(grouped.get(representative) ?? []), index]);
  });
  const clusters = [...grouped.values()];
  const deltas = queries.map((query, index) => ndcg(candidate[index]!, query.expected) - ndcg(baseline[index]!, query.expected));
  let state = 0x6d2b79f5;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const samples: number[] = [];
  for (let sample = 0; sample < 20000; sample++) {
    let sum = 0, count = 0;
    for (let draw = 0; draw < clusters.length; draw++) {
      for (const index of clusters[Math.floor(random() * clusters.length)]!) { sum += deltas[index]!; count++; }
    }
    samples.push(sum / Math.max(count, 1));
  }
  return {
    meanDelta: deltas.reduce((sum, value) => sum + value, 0) / Math.max(deltas.length, 1),
    ci95: [percentile(samples, 0.025), percentile(samples, 0.975)],
    clusterCount: clusters.length,
    bootstrapSamples: samples.length,
  };
}

try {
  const morphology = db.prepare('SELECT id FROM article_morph WHERE article_morph MATCH ? ORDER BY bm25(article_morph),id LIMIT 1000');
  for (const query of queries) {
    const parsed = parseSearchQuery(query.query, synonymMap);
    const mode = {
      label: 'saved-card-morph-fts-eval', description: 'same manual queries', k1: 1.5, b: 0.75, lambda: 0.085,
      contextBonus: 1.2, morphologicalWeight: 0.3, ngramWeight: 0.7, keywords: parsed.parsedKeywords,
    };
    let started = performance.now();
    const baseline = await runPipeline(documents, mode, 'benchmark-existing', { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 100 });
    baselineMs.push(performance.now() - started);
    baselineRankings.push(baseline.active.map(item => item.article.id));

    started = performance.now();
    const terms = parsed.parsedKeywords.flatMap(item => [item.term, ...item.synonyms]);
    const tokenSet = await buildStoredTokenSet(terms.join(' '));
    const uniqueTokens = [...new Set(tokenSet.morphologicalTokens.filter(Boolean))];
    const expression = uniqueTokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    const rows = expression ? morphology.all(expression) as Array<{ id: string }> : [];
    const ranking = rows.map(row => row.id).filter(id => corpusById.has(id));
    ftsMs.push(performance.now() - started);
    ftsRankings.push(ranking);
    candidateHits.push(query.expected.some(id => ranking.includes(id)));

    started = performance.now();
    const morphologyExpressions = uniqueTokens.map(token => `morph : "${token.replace(/"/g, '""')}"`);
    const ngramExpressions = [...new Set(tokenSet.ngramTokens.filter(Boolean))].map(token => `ngram : "${token.replace(/"/g, '""')}"`);
    const combinedExpression = [...morphologyExpressions, ...ngramExpressions].join(' OR ');
    const combinedRows = combinedExpression ? combinedSearch.all(combinedExpression) as Array<{ id: string }> : [];
    combinedRankings.push(combinedRows.map(row => row.id).filter(id => corpusById.has(id)));
    combinedMs.push(performance.now() - started);
  }

  const groups = [...new Set(queries.map(query => query.querySet))];
  const perQuery = queries.map((query, index) => {
    const rankOfExpected = (ranking: string[]) => {
      const rank = ranking.findIndex(id => query.expected.includes(id));
      return rank < 0 ? null : rank + 1;
    };
    return {
      queryId: query.id,
      querySet: query.querySet,
      expectedIds: query.expected,
      currentCustomBm25Rank: rankOfExpected(baselineRankings[index]!),
      standardFts5MorphologyBm25Rank: rankOfExpected(ftsRankings[index]!),
      standardFts5MorphologyAndNgramBm25Rank: rankOfExpected(combinedRankings[index]!),
      standardFts5CandidateCount: ftsRankings[index]!.length,
      ndcg10Delta: ndcg(ftsRankings[index]!, query.expected) - ndcg(baselineRankings[index]!, query.expected),
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: { name: 'anonymized-card-corpus-v2-manual-queries', documentCount: documents.length, queryCount: queries.length, querySets: groups, status: 'exploratory reused query set; not an independent holdout' },
    methods: {
      currentCustomBm25: { metrics: metrics(baselineRankings), latencyMs: { p50: percentile(baselineMs, 0.5), p95: percentile(baselineMs, 0.95) } },
      standardFts5MorphologyBm25: {
        metrics: metrics(ftsRankings), latencyMs: { p50: percentile(ftsMs, 0.5), p95: percentile(ftsMs, 0.95) },
        candidateRecallAt1000: candidateHits.filter(Boolean).length / candidateHits.length,
        ranking: 'SQLite FTS5 bm25() default parameters; morphology-token field only; top 1000; no title boost, no custom reranking',
        pairedNdcg10DeltaVsCurrent: pairedClusterBootstrap(baselineRankings, ftsRankings),
        pairedNdcg10DeltaVsStandardMorphologyAndNgramFts5: pairedClusterBootstrap(combinedRankings, ftsRankings),
      },
      standardFts5MorphologyAndNgramBm25: {
        metrics: metrics(combinedRankings), latencyMs: { p50: percentile(combinedMs, 0.5), p95: percentile(combinedMs, 0.95) },
        pairedNdcg10DeltaVsCurrent: pairedClusterBootstrap(baselineRankings, combinedRankings),
        ranking: 'SQLite FTS5 bm25() default parameters; separate morphology and N-gram fields; OR match; top 1000',
      },
    },
    querySetMetrics: Object.fromEntries(groups.map(group => {
      const indices = queries.flatMap((query, index) => query.querySet === group ? [index] : []);
      return [group, { queryCount: indices.length, currentCustomBm25: metrics(baselineRankings, indices), standardFts5MorphologyAndNgramBm25: metrics(combinedRankings, indices), standardFts5MorphologyBm25: metrics(ftsRankings, indices) }];
    })),
    perQuery,
    index: { buildMs: indexBuildMs, sizeBytes: indexSizeBytes, candidateLimit: 1000 },
    memory: { ...process.memoryUsage(), scope: 'benchmark process; no neural model loaded' },
  };
  const outputPath = path.join(root, 'quality/e2e/artifacts/saved-card-morph-fts-recheck-20261024.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...report.methods, querySetMetrics: report.querySetMetrics, index: report.index }, null, 2));
} finally {
  db.close();
  fs.rmSync(dbPath, { force: true });
}
