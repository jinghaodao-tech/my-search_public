import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { buildStoredTokenSet, runPipeline, type Article } from '../../bm25_engine.js';
import { parseSearchQuery } from '../../search/query_parser.js';
import { embedE5Texts } from '../../services/e5_embedding_service.js';
import { rerankWithE5Rrf } from '../../services/e5_rrf_ranker.js';

type Query = { id: string; query: string; expected: string[]; querySet: string };
type Doc = Article & { tokens: string[]; docLength: number; morphologicalTokens: string[]; ngramTokens: string[]; morphologicalDocLength: number; ngramDocLength: number };
type Metrics = { hitAt1: number; hitAt10: number; mrrAt10: number; ndcgAt10: number; recallAt100: number; mapAt100: number };
const root = process.cwd();
const dataRoot = path.join(root, 'data/search-evaluation');
const artifactPath = path.resolve(process.argv[2] ?? 'quality/e2e/artifacts/saved-card-full-e5-rrf-20261024.json');
if (!artifactPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(artifactPath)) throw new Error('Output must be a new file under artifacts/.');
const fixture = JSON.parse(fs.readFileSync(path.join(dataRoot, 'anonymized-corpus.json'), 'utf8')) as { documents: Array<Record<string, unknown>> };
const querySets = ['real-queries.json', 'real-queries-v2.json'].map(file => ({ file, rows: JSON.parse(fs.readFileSync(path.join(dataRoot, file), 'utf8')) as Array<Omit<Query, 'querySet'>> }));
const queries = querySets.flatMap(({ file, rows }) => rows.map(row => ({ ...row, querySet: file })));
const corpus = fixture.documents.map(row => ({
  id: String(row.id), title: String(row.title), summary: String(row.summary ?? ''), body: String(row.body), url: String(row.url), tags: (row.tags as string[] | undefined) ?? [],
  sourceAuthority: Number(row.sourceAuthority ?? 0.8), publishedAt: new Date(String(row.publishedAt)), tokens: row.tokens as string[], docLength: Number(row.docLength ?? (row.tokens as string[]).length),
  morphologicalTokens: (row.morphologicalTokens as string[] | undefined) ?? row.tokens as string[], ngramTokens: (row.ngramTokens as string[] | undefined) ?? row.tokens as string[],
  morphologicalDocLength: Number(row.morphologicalDocLength ?? (row.morphologicalTokens as string[] | undefined)?.length ?? (row.tokens as string[]).length),
  ngramDocLength: Number(row.ngramDocLength ?? (row.ngramTokens as string[] | undefined)?.length ?? (row.tokens as string[]).length),
} satisfies Doc));
const tempDb = path.join(os.tmpdir(), `my-search-full-e5-${process.pid}.sqlite`);
const fts = new Database(tempDb);
fts.exec('CREATE VIRTUAL TABLE combined USING fts5(id UNINDEXED,morph,ngram); CREATE VIRTUAL TABLE morphology USING fts5(id UNINDEXED,tokens);');
const insertCombined = fts.prepare('INSERT INTO combined(id,morph,ngram) VALUES(?,?,?)');
const insertMorph = fts.prepare('INSERT INTO morphology(id,tokens) VALUES(?,?)');
fts.transaction(() => {
  for (const doc of corpus) {
    const morph = doc.morphologicalTokens.join(' ');
    insertCombined.run(doc.id, morph, doc.ngramTokens.join(' '));
    insertMorph.run(doc.id, morph);
  }
})();
const quote = (terms: string[]) => [...new Set(terms.filter(Boolean))].map(term => `"${term.replaceAll('"', '""')}"`);
const expression = (column: string, terms: string[]) => quote(terms).map(term => `${column} : ${term}`).join(' OR ');
const combinedSearch = fts.prepare('SELECT id FROM combined WHERE combined MATCH ? ORDER BY bm25(combined),id');
const morphSearch = fts.prepare('SELECT id FROM morphology WHERE morphology MATCH ? ORDER BY bm25(morphology),id');
const methods = ['customBm25', 'standardFts5MorphNgram', 'standardFts5Morph', 'e5Top100Rrf', 'e5FullCorpus', 'fullCorpusBm25E5Rrf', 'fullCorpusStandardBm25E5Rrf', 'fullCorpusStandardBm25E5RrfW2', 'fullCorpusStandardBm25E5RrfW4', 'fullCorpusStandardBm25E5RrfW8'] as const;
const rankings: Record<(typeof methods)[number], string[][]> = {
  customBm25: [], standardFts5MorphNgram: [], standardFts5Morph: [], e5Top100Rrf: [], e5FullCorpus: [], fullCorpusBm25E5Rrf: [], fullCorpusStandardBm25E5Rrf: [], fullCorpusStandardBm25E5RrfW2: [], fullCorpusStandardBm25E5RrfW4: [], fullCorpusStandardBm25E5RrfW8: [],
};
const latency: Record<'e5Top100Rrf' | 'e5FullCorpus' | 'fullCorpusBm25E5Rrf' | 'fullCorpusStandardBm25E5Rrf', number[]> = { e5Top100Rrf: [], e5FullCorpus: [], fullCorpusBm25E5Rrf: [], fullCorpusStandardBm25E5Rrf: [] };
const candidates = new Map<string, Doc>(corpus.map(doc => [doc.id, doc]));
const passageTexts = corpus.map(doc => `passage: ${[doc.title, doc.summary, doc.tags?.join(' '), doc.body].filter(Boolean).join('\n').normalize('NFKC')}`);
const embeddingBuildStarted = performance.now();
const passageVectors = await embedE5Texts(passageTexts);
const embeddingBuildMs = performance.now() - embeddingBuildStarted;
const dot = (left: Float32Array, right: Float32Array) => { let sum = 0; for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!; return sum; };
const reciprocalRankFusion = (left: string[], right: string[], leftWeight = 1) => {
  const scoreById = new Map<string, number>();
  left.forEach((id, index) => scoreById.set(id, (scoreById.get(id) ?? 0) + leftWeight / (60 + index + 1)));
  right.forEach((id, index) => scoreById.set(id, (scoreById.get(id) ?? 0) + 1 / (60 + index + 1)));
  return [...scoreById].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
};
const synonymMap = { bm25: ['ranking'], token: ['tokens_json'], csv: ['json'], validation: ['validate'] };
const modeFor = (keywords: Array<{ term: string; weight: number; synonyms: string[] }>) => ({ label: 'saved-card-full-e5-benchmark', description: 'exploratory full-corpus semantic candidate comparison', k1: 1.5, b: 0.75, lambda: 0.085, contextBonus: 1.2, morphologicalWeight: 0.3, ngramWeight: 0.7, keywords });
let firstE5RequestMs = 0;
for (const query of queries) {
  const parsed = parseSearchQuery(query.query, synonymMap);
  const terms = parsed.parsedKeywords.flatMap(item => [item.term, ...item.synonyms]);
  const set = await buildStoredTokenSet(terms.join(' '));
  const combinedExpression = [expression('morph', set.morphologicalTokens), expression('ngram', set.ngramTokens)].filter(Boolean).join(' OR ');
  const morphExpression = expression('tokens', set.morphologicalTokens);
  rankings.standardFts5MorphNgram.push(combinedExpression ? (combinedSearch.all(combinedExpression) as Array<{ id: string }>).map(row => row.id) : []);
  rankings.standardFts5Morph.push(morphExpression ? (morphSearch.all(morphExpression) as Array<{ id: string }>).map(row => row.id) : []);

  const started = performance.now();
  const current = await runPipeline(corpus, modeFor(parsed.parsedKeywords), 'saved-card-full-e5-benchmark', { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: corpus.length });
  const bm25Rows = current.active.map(row => ({ article: candidates.get(row.article.id)!, score: row.score }));
  rankings.customBm25.push(bm25Rows.map(row => row.article.id));
  const top100Started = performance.now();
  const top100 = await rerankWithE5Rrf(bm25Rows.slice(0, 100), terms.join(' '));
  latency.e5Top100Rrf.push(performance.now() - top100Started);
  rankings.e5Top100Rrf.push(top100.map(row => row.item.article.id));

  const fullStarted = performance.now();
  const queryVector = (await embedE5Texts([`query: ${terms.join(' ')}`]))[0]!;
  const denseRanking = corpus.map((doc, index) => ({ id: doc.id, score: dot(queryVector, passageVectors[index]!) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(row => row.id);
  const lexicalBm25 = rankings.customBm25.at(-1)!;
  const lexicalFts = rankings.standardFts5MorphNgram.at(-1)!;
  rankings.e5FullCorpus.push(denseRanking);
  rankings.fullCorpusBm25E5Rrf.push(reciprocalRankFusion(lexicalBm25, denseRanking));
  rankings.fullCorpusStandardBm25E5Rrf.push(reciprocalRankFusion(lexicalFts, denseRanking));
  rankings.fullCorpusStandardBm25E5RrfW2.push(reciprocalRankFusion(lexicalFts, denseRanking, 2));
  rankings.fullCorpusStandardBm25E5RrfW4.push(reciprocalRankFusion(lexicalFts, denseRanking, 4));
  rankings.fullCorpusStandardBm25E5RrfW8.push(reciprocalRankFusion(lexicalFts, denseRanking, 8));
  const fullElapsed = performance.now() - fullStarted;
  latency.e5FullCorpus.push(fullElapsed);
  latency.fullCorpusBm25E5Rrf.push(fullElapsed);
  latency.fullCorpusStandardBm25E5Rrf.push(fullElapsed);
  if (!firstE5RequestMs) firstE5RequestMs = performance.now() - started;
}

function score(ranking: string[], expected: string[]): Metrics {
  const gold = new Set(expected);
  const first = ranking.findIndex(id => gold.has(id));
  const top10 = ranking.slice(0, 10);
  const dcg = top10.reduce((sum, id, index) => sum + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(gold.size, 10) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  let hits = 0; let ap = 0;
  ranking.slice(0, 100).forEach((id, index) => { if (gold.has(id)) { hits++; ap += hits / (index + 1); } });
  return { hitAt1: Number(first === 0), hitAt10: Number(first >= 0 && first < 10), mrrAt10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcgAt10: ideal ? dcg / ideal : 0, recallAt100: hits / Math.max(gold.size, 1), mapAt100: ap / Math.max(gold.size, 1) };
}
const means = Object.fromEntries(methods.map(method => [method, Object.fromEntries((Object.keys(score([], [])) as Array<keyof Metrics>).map(metric => [metric, queries.reduce((sum, query, index) => sum + score(rankings[method]![index]!, query.expected)[metric], 0) / queries.length]))]));
function clusterInterval(left: string[][], right: string[][]) {
  const parent = queries.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  queries.forEach((query, index) => query.expected.forEach(id => { const previous = queries.findIndex((other, otherIndex) => otherIndex !== index && other.expected.includes(id)); if (previous >= 0) parent[find(index)] = find(previous); }));
  const clusters = [...new Set(queries.map((_, index) => find(index)))].map(rootId => queries.map((_, index) => index).filter(index => find(index) === rootId));
  const deltas = queries.map((query, index) => score(right[index]!, query.expected).ndcgAt10 - score(left[index]!, query.expected).ndcgAt10);
  let seed = 0x2c813f71;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = Array.from({ length: 20_000 }, () => {
    const values: number[] = [];
    for (let index = 0; index < clusters.length; index++) for (const row of clusters[Math.floor(random() * clusters.length)]!) values.push(deltas[row]!);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }).sort((a, b) => a - b);
  return { meanDelta: deltas.reduce((sum, value) => sum + value, 0) / deltas.length, ci95: [draws[499]!, draws[19499]!], clusterCount: clusters.length, bootstrapSamples: draws.length };
}
const ftsBaseline = rankings.standardFts5MorphNgram;
const comparisons = Object.fromEntries(methods.filter(method => method !== 'standardFts5MorphNgram').map(method => [method, clusterInterval(ftsBaseline, rankings[method])]));
const artifact = {
  dataset: { name: 'anonymized-card-corpus-v2-manual-queries', documents: corpus.length, queries: queries.length, labelSource: 'existing manually labeled relevance queries; reused exploratory data', status: 'diagnostic only; not an independent holdout' },
  method: { e5: 'Xenova/multilingual-e5-small q8; query/passage prefixes; independently scores all 233 cards', fusion: 'RRF k=60 between full-corpus BM25 or standard FTS5 ranking and independent full-corpus E5 ranking; separate BM25 Top-100 E5 rerank comparator', embeddingBuildMs, productionChanged: false },
  metrics: means,
  pairedNdcg10VsStandardFts5MorphNgram: comparisons,
  latencyMs: Object.fromEntries(Object.entries(latency).map(([method, samples]) => [method, { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), firstRequestTotal: firstE5RequestMs }])),
  perQuery: queries.map((query, index) => ({ id: query.id, querySet: query.querySet, query: query.query, expected: query.expected, ranks: Object.fromEntries(methods.map(method => [method, rankings[method]![index]!.findIndex(id => query.expected.includes(id)) + 1 || null])) })),
};
function percentile(values: number[], p: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0; }
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath: artifactPath, dataset: artifact.dataset, metrics: artifact.metrics, pairedNdcg10VsStandardFts5MorphNgram: artifact.pairedNdcg10VsStandardFts5MorphNgram, latencyMs: artifact.latencyMs }, null, 2));
fts.close();
