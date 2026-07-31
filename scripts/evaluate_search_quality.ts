import fs from 'node:fs';
import path from 'node:path';
import { runPipeline, type Article } from '../bm25_engine.js';

type SearchCase = { id: string; query: string; keywords: Array<{ term: string; weight: number; synonyms?: string[] }>; expected: string[] };
type Variant = { name: string; synonym: boolean; lambda: number };

function baseArticle(id: string, title: string, body: string, tokens: string[], authority = 0.8): Article {
  return { id, title, body, url: `https://example.test/${id}`, sourceAuthority: authority, publishedAt: new Date('2026-01-01T00:00:00.000Z'), tokens, docLength: tokens.length };
}

const articles: Article[] = [
  baseArticle('sqlite-bm25', 'SQLite BM25 token cache', 'Persisting tokens_json and doc_length makes local search fast.', ['sqlite','bm25','token','cache','tokens_json','doc_length','local','search']),
  baseArticle('zettelkasten-links', 'Zettelkasten backlinks and graph notes', 'Cards link to other cards and show backlinks for knowledge navigation.', ['zettelkasten','backlinks','links','graph','cards','knowledge','navigation']),
  baseArticle('csv-import', 'CSV and JSON import validation', 'Importers validate local card data before saving it into SQLite.', ['csv','json','import','validation','validate','local','card','data']),
  baseArticle('ui-polish', 'Dashboard visual layout memo', 'Small UI adjustments improve spacing, colors, and readability.', ['dashboard','visual','layout','spacing','colors','readability']),
  baseArticle('jp-search', '保存済みカード検索', '保存済みの知識を通常検索で再発見する。', ['保存','済み','カード','検索','知識','発見']),
  ...Array.from({ length: 45 }, (_, index) => baseArticle(`noise-${index}`, `Unrelated document ${index}`, `Archive note ${index} about unrelated operations and maintenance.`, ['archive','operations','maintenance',`noise-${index}`], 0.2)),
];

const cases: SearchCase[] = [
  { id: 'bm25-cache', query: 'BM25 token cache', keywords: [{ term: 'BM25', weight: 2, synonyms: ['ranking'] }, { term: 'token', weight: 1.5, synonyms: ['tokens_json'] }, { term: 'SQLite', weight: 1.2 }], expected: ['sqlite-bm25'] },
  { id: 'sqlite-search', query: 'SQLite local search', keywords: [{ term: 'SQLite', weight: 2 }, { term: 'search', weight: 1.5 }], expected: ['sqlite-bm25'] },
  { id: 'doc-length', query: 'token document length', keywords: [{ term: 'token', weight: 1.5 }, { term: 'doc_length', weight: 2 }], expected: ['sqlite-bm25'] },
  { id: 'backlinks-graph', query: 'card backlinks graph', keywords: [{ term: 'backlinks', weight: 2, synonyms: ['links'] }, { term: 'graph', weight: 1.5 }], expected: ['zettelkasten-links'] },
  { id: 'zettelkasten', query: 'Zettelkasten knowledge navigation', keywords: [{ term: 'Zettelkasten', weight: 2 }, { term: 'knowledge', weight: 1.5 }], expected: ['zettelkasten-links'] },
  { id: 'links', query: 'links and backlinks', keywords: [{ term: 'links', weight: 1.5, synonyms: ['backlinks'] }], expected: ['zettelkasten-links'] },
  { id: 'csv-validation', query: 'CSV JSON validation', keywords: [{ term: 'CSV', weight: 1.5, synonyms: ['JSON'] }, { term: 'validation', weight: 2, synonyms: ['validate'] }], expected: ['csv-import'] },
  { id: 'import-data', query: 'import local card data', keywords: [{ term: 'import', weight: 2 }, { term: 'data', weight: 1.2 }], expected: ['csv-import'] },
  { id: 'json-import', query: 'JSON import validation', keywords: [{ term: 'JSON', weight: 2 }, { term: 'import', weight: 1.2 }], expected: ['csv-import'] },
  { id: 'dashboard-layout', query: 'dashboard visual layout', keywords: [{ term: 'dashboard', weight: 2 }, { term: 'layout', weight: 1.5 }], expected: ['ui-polish'] },
  { id: 'ui-spacing', query: 'UI spacing readability', keywords: [{ term: 'spacing', weight: 2 }, { term: 'readability', weight: 1.5 }], expected: ['ui-polish'] },
  { id: 'visual-colors', query: 'visual colors', keywords: [{ term: 'visual', weight: 2 }, { term: 'colors', weight: 1 }], expected: ['ui-polish'] },
  { id: 'jp-saved-search', query: '保存済みカード検索', keywords: [{ term: '保存済み', weight: 2 }, { term: '検索', weight: 1.5 }], expected: ['jp-search'] },
  { id: 'jp-knowledge', query: '知識を再発見', keywords: [{ term: '知識', weight: 2 }, { term: '再発見', weight: 1.5 }], expected: ['jp-search'] },
  { id: 'jp-card', query: 'カード 検索', keywords: [{ term: 'カード', weight: 2 }, { term: '検索', weight: 1 }], expected: ['jp-search'] },
  { id: 'bm25-ranking', query: 'ranking synonym search', keywords: [{ term: 'ranking', weight: 2, synonyms: ['BM25'] }, { term: 'search', weight: 1 }], expected: ['sqlite-bm25'] },
  { id: 'graph-navigation', query: 'knowledge graph navigation', keywords: [{ term: 'knowledge', weight: 1.5 }, { term: 'navigation', weight: 2 }], expected: ['zettelkasten-links'] },
  { id: 'local-import', query: 'local CSV import', keywords: [{ term: 'local', weight: 1.5 }, { term: 'import', weight: 2 }], expected: ['csv-import'] },
  { id: 'readability', query: 'colors readability spacing', keywords: [{ term: 'readability', weight: 2 }, { term: 'spacing', weight: 1 }], expected: ['ui-polish'] },
  { id: 'jp-discovery', query: '保存 知識 再発見', keywords: [{ term: '保存済み', weight: 1.5 }, { term: '再発見', weight: 2 }], expected: ['jp-search'] },
];

const variants: Variant[] = [
  { name: 'current-bm25', synonym: true, lambda: 0.1 },
  { name: 'without-synonym', synonym: false, lambda: 0.1 },
  { name: 'without-time-decay', synonym: true, lambda: 0 },
];

function precisionAt(results: string[], expected: string[], k: number): number {
  const set = new Set(expected);
  return results.slice(0, k).filter(id => set.has(id)).length / Math.min(k, results.length || k);
}
function reciprocalRank(results: string[], expected: string[]): number {
  const set = new Set(expected); const index = results.findIndex(id => set.has(id)); return index < 0 ? 0 : 1 / (index + 1);
}
function recallAt5(results: string[], expected: string[]): number {
  const set = new Set(expected); return results.slice(0, 5).filter(id => set.has(id)).length / set.size;
}
function ndcgAt5(results: string[], expected: string[]): number {
  const set = new Set(expected); const dcg = results.slice(0, 5).reduce((sum, id, index) => sum + (set.has(id) ? 1 / Math.log2(index + 2) : 0), 0); const ideal = Array.from({ length: Math.min(5, set.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0); return ideal ? dcg / ideal : 0;
}

async function evaluateVariant(variant: Variant) {
  const rows = [];
  for (const testCase of cases) {
    const keywords = testCase.keywords.map(keyword => ({ ...keyword, synonyms: variant.synonym ? (keyword.synonyms ?? []) : [] }));
    const result = await runPipeline(articles, { label: variant.name, description: 'Expanded deterministic evaluation', k1: 1.5, b: 0.75, lambda: variant.lambda, contextBonus: 1.2, keywords }, 'search-quality', { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 5 });
    const ranked = result.active.map(item => item.article.id);
    rows.push({ case: testCase.id, query: testCase.query, top1: ranked[0] ?? '', expected: testCase.expected.join(', '), precisionAt1: precisionAt(ranked, testCase.expected, 1), precisionAt3: precisionAt(ranked, testCase.expected, 3), reciprocalRank: reciprocalRank(ranked, testCase.expected), recallAt5: recallAt5(ranked, testCase.expected), ndcgAt5: ndcgAt5(ranked, testCase.expected) });
  }
  return { variant: variant.name, rows, meanPrecisionAt1: rows.reduce((sum, row) => sum + row.precisionAt1, 0) / rows.length, meanPrecisionAt3: rows.reduce((sum, row) => sum + row.precisionAt3, 0) / rows.length, mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length, recallAt5: rows.reduce((sum, row) => sum + row.recallAt5, 0) / rows.length, ndcgAt5: rows.reduce((sum, row) => sum + row.ndcgAt5, 0) / rows.length };
}

const evaluations = [];
for (const variant of variants) evaluations.push(await evaluateVariant(variant));
const current = evaluations[0];
console.table(current.rows.map(row => ({ case: row.case, top1: row.top1, expected: row.expected, p1: row.precisionAt1.toFixed(3), p3: row.precisionAt3.toFixed(3), mrr: row.reciprocalRank.toFixed(3), r5: row.recallAt5.toFixed(3), ndcg5: row.ndcgAt5.toFixed(3) })));
const qualityArtifact = { dataset: { version: 'v2-50-docs-20-queries', documents: articles.length, queries: cases.length, languages: ['English', 'Japanese'] }, metrics: { precisionAt1: Number(current.meanPrecisionAt1.toFixed(3)), precisionAt3: Number(current.meanPrecisionAt3.toFixed(3)), mrr: Number(current.mrr.toFixed(3)), recallAt5: Number(current.recallAt5.toFixed(3)), ndcgAt5: Number(current.ndcgAt5.toFixed(3)) }, thresholds: { precisionAt1: 0.85, mrr: 0.9, recallAt5: 0.9, ndcgAt5: 0.85 }, variants: evaluations.map(evaluation => ({ variant: evaluation.variant, precisionAt1: Number(evaluation.meanPrecisionAt1.toFixed(3)), precisionAt3: Number(evaluation.meanPrecisionAt3.toFixed(3)), mrr: Number(evaluation.mrr.toFixed(3)), recallAt5: Number(evaluation.recallAt5.toFixed(3)), ndcgAt5: Number(evaluation.ndcgAt5.toFixed(3)) })) };
fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'search-quality.json'), JSON.stringify(qualityArtifact, null, 2), 'utf-8');
console.log(JSON.stringify(qualityArtifact, null, 2));
if (qualityArtifact.metrics.precisionAt1 < qualityArtifact.thresholds.precisionAt1 || qualityArtifact.metrics.mrr < qualityArtifact.thresholds.mrr || qualityArtifact.metrics.recallAt5 < qualityArtifact.thresholds.recallAt5 || qualityArtifact.metrics.ndcgAt5 < qualityArtifact.thresholds.ndcgAt5) process.exitCode = 1;
