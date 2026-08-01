import fs from 'node:fs';
import path from 'node:path';
import { runPipeline, type Article } from '../bm25_engine.js';
import { excludesArticle, parseSearchQuery, type ParsedSearchQuery } from '../search/query_parser.js';

type SearchCase = { id: string; query: string; keywords: Array<{ term: string; weight: number; synonyms?: string[] }>; expected: string[]; kind: string };
type Variant = { name: string; synonym: boolean; lambda: number };
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
function article(id: string, title: string, body: string, tokens: string[], publishedAt = '2026-01-01', authority = 0.8): Article { return { id, title, body, url: `https://example.test/${id}`, sourceAuthority: authority, publishedAt: date(publishedAt), tokens, docLength: tokens.length }; }

const articles: Article[] = [
  article('sqlite-bm25', 'SQLite BM25 token cache', 'Persisting tokens_json and doc_length makes local search fast.', ['sqlite','bm25','token','cache','tokens_json','doc_length','local','search']),
  article('sqlite-token-persistence', 'SQLite token persistence', 'SQLite stores token cache data for fast local search and reliable first indexing.', ['sqlite','token','persistence','cache','local','search','first','indexing']),
  article('zettelkasten-links', 'Zettelkasten backlinks and graph notes', 'Cards link to other cards and show backlinks for knowledge navigation.', ['zettelkasten','backlinks','links','graph','cards','knowledge','navigation']),
  article('csv-import', 'CSV and JSON import validation', 'Importers validate local card data before saving it into SQLite.', ['csv','json','import','validation','validate','local','card','data']),
  article('ui-polish', 'Dashboard visual layout memo', 'Small UI adjustments improve spacing, colors, and readability.', ['dashboard','visual','layout','spacing','colors','readability']),
  article('jp-search', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9\u306e\u691c\u7d22', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9\u3092\u30ed\u30fc\u30ab\u30eb\u691c\u7d22\u3067\u518d\u767a\u898b\u3059\u308b\u3002', ['\u4fdd\u5b58','\u6e08\u307f','\u30ab\u30fc\u30c9','\u30ed\u30fc\u30ab\u30eb','\u691c\u7d22','\u518d\u767a\u898b']),
  article('near-negative-ui', 'BM25 UI color dashboard', 'BM25, SQLite, and token are mentioned here, but this is a UI design note rather than search persistence.', ['bm25','sqlite','token','ui','color','dashboard','design']),
  article('title-body-conflict', 'SQLite BM25 color UI', 'The actual topic is dashboard visual color design, not token persistence.', ['sqlite','bm25','color','ui','dashboard','visual','design']),
  article('long-document', 'Long document local search', `${'Background archive noise '.repeat(30)} local search long document retrieval target tokens.`, ['long','document','local','search','retrieval','target']),
  article('saved-old', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', '\u53e4\u3044\u8a18\u9332', ['\u4fdd\u5b58','\u6e08\u307f','\u30ab\u30fc\u30c9','\u30ed\u30fc\u30ab\u30eb','\u691c\u7d22','\u518d\u767a\u898b'], '2025-01-01'),
  article('saved-new', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', '\u65b0\u3057\u3044\u8a18\u9332', ['\u4fdd\u5b58','\u6e08\u307f','\u30ab\u30fc\u30c9','\u30ed\u30fc\u30ab\u30eb','\u691c\u7d22','\u518d\u767a\u898B'], '2026-07-30'),
  ...Array.from({ length: 39 }, (_, index) => article(`noise-${index}`, `Unrelated document ${index}`, `Archive note ${index} about unrelated operations and maintenance.`, ['archive','operations','maintenance',`noise-${index}`], '2026-01-01', 0.2)),
];

const cases: SearchCase[] = [
  { id: 'bm25-cache', kind: 'clear-positive', query: 'BM25 token cache', keywords: [{ term: 'BM25', weight: 2, synonyms: ['ranking'] }, { term: 'token', weight: 1.5, synonyms: ['tokens_json'] }, { term: 'SQLite', weight: 1.2 }], expected: ['sqlite-bm25'] },
  { id: 'sqlite-persistence', kind: 'clear-positive', query: 'SQLite BM25 token caching', keywords: [{ term: 'SQLite', weight: 2 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 1.5 }], expected: ['sqlite-token-persistence','sqlite-bm25'] },
  { id: 'backlinks-graph', kind: 'clear-positive', query: 'card backlinks graph', keywords: [{ term: 'backlinks', weight: 2, synonyms: ['links'] }, { term: 'graph', weight: 1.5 }], expected: ['zettelkasten-links'] },
  { id: 'csv-validation', kind: 'clear-positive', query: 'CSV JSON validation', keywords: [{ term: 'CSV', weight: 1.5, synonyms: ['JSON'] }, { term: 'validation', weight: 2, synonyms: ['validate'] }], expected: ['csv-import'] },
  { id: 'dashboard-layout', kind: 'clear-positive', query: 'dashboard visual layout', keywords: [{ term: 'dashboard', weight: 2 }, { term: 'layout', weight: 1.5 }], expected: ['ui-polish'] },
  { id: 'jp-saved-search', kind: 'japanese', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', keywords: [{ term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 2 }, { term: '\u30ed\u30fc\u30ab\u30eb\u691c\u7d22', weight: 1.5 }], expected: ['jp-search'] },
  { id: 'near-negative', kind: 'near-negative', query: 'SQLite token persistence', keywords: [{ term: 'SQLite', weight: 2 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 2 }], expected: ['sqlite-token-persistence'] },
  { id: 'title-body-conflict', kind: 'title-body-conflict', query: 'SQLite token persistence', keywords: [{ term: 'SQLite', weight: 1 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 2 }], expected: ['sqlite-token-persistence'] },
  { id: 'long-document', kind: 'long-document', query: 'long document local search', keywords: [{ term: 'long', weight: 1.5 }, { term: 'document', weight: 1.5 }, { term: 'local', weight: 1 }, { term: 'search', weight: 1 }], expected: ['long-document'] },
  { id: 'time-decay', kind: 'time-decay-trap', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22 \u518d\u767a\u898b', keywords: [{ term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 2 }, { term: '\u30ed\u30fc\u30ab\u30eb\u691c\u7d22', weight: 1.5 }, { term: '\u518d\u767a\u898b', weight: 1 }], expected: ['saved-new','saved-old'] },
  { id: 'parser-ambiguity', kind: 'parser-ambiguity', query: '"SQLite BM25" \u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 -UI', keywords: [{ term: 'SQLite', weight: 1.5 }, { term: 'BM25', weight: 1.5 }, { term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 1 }], expected: ['sqlite-bm25'] },
];
const variants: Variant[] = [{ name: 'current-bm25', synonym: true, lambda: 0.1 }, { name: 'without-synonym', synonym: false, lambda: 0.1 }, { name: 'without-time-decay', synonym: true, lambda: 0 }];
const synonymMap: Record<string, string[]> = { bm25: ['ranking'], token: ['tokens_json'], csv: ['json'], validation: ['validate'] };
function precisionAt(results: string[], expected: string[], k: number): number { const set = new Set(expected); return results.slice(0, k).filter(id => set.has(id)).length / Math.min(k, results.length || k); }
function reciprocalRank(results: string[], expected: string[]): number { const set = new Set(expected); const index = results.findIndex(id => set.has(id)); return index < 0 ? 0 : 1 / (index + 1); }
function recallAt5(results: string[], expected: string[]): number { const set = new Set(expected); return results.slice(0, 5).filter(id => set.has(id)).length / set.size; }
function ndcgAt5(results: string[], expected: string[]): number { const set = new Set(expected); const dcg = results.slice(0, 5).reduce((sum, id, index) => sum + (set.has(id) ? 1 / Math.log2(index + 2) : 0), 0); const ideal = Array.from({ length: Math.min(5, set.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0); return ideal ? dcg / ideal : 0; }
async function evaluateVariant(variant: Variant, endToEnd: boolean) {
  const rows = [];
  for (const testCase of cases) {
    const parsed: ParsedSearchQuery | undefined = endToEnd ? parseSearchQuery(testCase.query, variant.synonym ? synonymMap : {}) : undefined;
    const keywords = parsed?.parsedKeywords ?? testCase.keywords.map(keyword => ({ ...keyword, synonyms: variant.synonym ? (keyword.synonyms ?? []) : [] }));
    const result = await runPipeline(articles, { label: variant.name, description: endToEnd ? 'Raw query parser evaluation' : 'Keyword ranking evaluation', k1: 1.5, b: 0.75, lambda: variant.lambda, contextBonus: 1.2, keywords }, endToEnd ? 'end-to-end-query' : 'ranking-only', { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 5 });
    const ranked = result.active.filter(item => !parsed || !excludesArticle(item.article, parsed.excludedTerms)).map(item => item.article.id);
    rows.push({ case: testCase.id, kind: testCase.kind, query: testCase.query, ...(endToEnd ? { rawQuery: testCase.query, parsedKeywords: keywords } : { rankingKeywords: keywords }), top1: ranked[0] ?? '', expected: testCase.expected, precisionAt1: precisionAt(ranked, testCase.expected, 1), precisionAt3: precisionAt(ranked, testCase.expected, 3), reciprocalRank: reciprocalRank(ranked, testCase.expected), recallAt5: recallAt5(ranked, testCase.expected), ndcgAt5: ndcgAt5(ranked, testCase.expected) });
  }
  return { variant: variant.name, rows, meanPrecisionAt1: rows.reduce((sum, row) => sum + row.precisionAt1, 0) / rows.length, meanPrecisionAt3: rows.reduce((sum, row) => sum + row.precisionAt3, 0) / rows.length, mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length, recallAt5: rows.reduce((sum, row) => sum + row.recallAt5, 0) / rows.length, ndcgAt5: rows.reduce((sum, row) => sum + row.ndcgAt5, 0) / rows.length };
}
function artifact(evaluation: Awaited<ReturnType<typeof evaluateVariant>>, scope: string, pipeline: string[]) { return { scope, pipeline, dataset: { version: 'v4-50-docs-11-query-cases', documents: articles.length, queries: cases.length, caseKinds: [...new Set(cases.map(testCase => testCase.kind))], languages: ['English', 'Japanese'] }, rows: evaluation.rows, metrics: { precisionAt1: Number(evaluation.meanPrecisionAt1.toFixed(3)), precisionAt3: Number(evaluation.meanPrecisionAt3.toFixed(3)), mrr: Number(evaluation.mrr.toFixed(3)), recallAt5: Number(evaluation.recallAt5.toFixed(3)), ndcgAt5: Number(evaluation.ndcgAt5.toFixed(3)) }, thresholds: { precisionAt1: 0.75, mrr: 0.8, recallAt5: 0.8, ndcgAt5: 0.75 }, variants: [] as unknown[] }; }
const rankingEvaluations = []; const endToEndEvaluations = [];
for (const variant of variants) { rankingEvaluations.push(await evaluateVariant(variant, false)); endToEndEvaluations.push(await evaluateVariant(variant, true)); }
const ranking = artifact(rankingEvaluations[0], 'ranking-only', ['keywords', 'ranking_engine']); ranking.variants = rankingEvaluations.map(({ variant, rows: _rows, ...metrics }) => metrics);
const endToEnd = artifact(endToEndEvaluations[0], 'end-to-end-query', ['raw_query', 'query_parser', 'keyword_candidates', 'ranking_engine']); endToEnd.variants = endToEndEvaluations.map(({ variant, rows: _rows, ...metrics }) => metrics);
fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'ranking-engine-quality.json'), JSON.stringify(ranking, null, 2), 'utf-8');
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'end-to-end-query-quality.json'), JSON.stringify(endToEnd, null, 2), 'utf-8');
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'search-quality.json'), JSON.stringify({ ranking, endToEnd }, null, 2), 'utf-8');
console.log(JSON.stringify({ ranking: { metrics: ranking.metrics, rows: ranking.rows.length }, endToEnd: { metrics: endToEnd.metrics, rows: endToEnd.rows.length } }, null, 2));
if (ranking.metrics.precisionAt1 < ranking.thresholds.precisionAt1 || endToEnd.metrics.precisionAt1 < endToEnd.thresholds.precisionAt1 || endToEnd.metrics.mrr < endToEnd.thresholds.mrr || endToEnd.metrics.recallAt5 < endToEnd.thresholds.recallAt5) process.exitCode = 1;
