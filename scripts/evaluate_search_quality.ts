import { runPipeline, type Article } from '../bm25_engine.js';

type SearchCase = {
  id: string;
  queryLabel: string;
  keywords: Array<{ term: string; weight: number; synonyms?: string[] }>;
  expectedTopIds: string[];
};

const articles: Article[] = [
  {
    id: 'sqlite-bm25',
    title: 'SQLite BM25 token cache',
    body: 'Persisting tokens_json and doc_length avoids repeated tokenization during local search.',
    url: 'https://example.test/sqlite-bm25',
    sourceAuthority: 0.9,
    publishedAt: new Date('2026-01-03T00:00:00.000Z'),
    tokens: ['sqlite', 'bm', '25', 'token', 'cache', 'tokens_json', 'doc_length', 'local', 'search'],
    docLength: 9,
  },
  {
    id: 'zettelkasten-links',
    title: 'Zettelkasten backlinks and graph notes',
    body: 'Cards can link to other cards and show backlinks for knowledge navigation.',
    url: 'https://example.test/zettelkasten',
    sourceAuthority: 0.8,
    publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    tokens: ['zettelkasten', 'backlinks', 'links', 'graph', 'cards', 'knowledge', 'navigation'],
    docLength: 7,
  },
  {
    id: 'csv-import',
    title: 'CSV and JSON import validation',
    body: 'Importers validate local card data before saving it into SQLite.',
    url: 'https://example.test/import',
    sourceAuthority: 0.7,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    tokens: ['csv', 'json', 'import', 'validation', 'validate', 'local', 'card', 'data'],
    docLength: 8,
  },
  {
    id: 'ui-polish',
    title: 'Dashboard visual layout memo',
    body: 'Small UI adjustments improve spacing, colors, and readability.',
    url: 'https://example.test/ui',
    sourceAuthority: 0.4,
    publishedAt: new Date('2025-12-30T00:00:00.000Z'),
    tokens: ['dashboard', 'visual', 'layout', 'spacing', 'colors', 'readability'],
    docLength: 6,
  },
];

const cases: SearchCase[] = [
  {
    id: 'bm25-cache',
    queryLabel: 'BM25 token cache',
    keywords: [
      { term: 'BM25', weight: 2, synonyms: ['ranking'] },
      { term: 'token', weight: 1.5, synonyms: ['tokens_json'] },
      { term: 'SQLite', weight: 1.2, synonyms: [] },
    ],
    expectedTopIds: ['sqlite-bm25'],
  },
  {
    id: 'links-backlinks',
    queryLabel: 'card backlinks graph',
    keywords: [
      { term: 'backlinks', weight: 2, synonyms: ['links'] },
      { term: 'graph', weight: 1.5, synonyms: ['navigation'] },
    ],
    expectedTopIds: ['zettelkasten-links'],
  },
  {
    id: 'import-validation',
    queryLabel: 'CSV JSON validation',
    keywords: [
      { term: 'CSV', weight: 1.5, synonyms: ['JSON'] },
      { term: 'validation', weight: 2, synonyms: ['validate'] },
    ],
    expectedTopIds: ['csv-import'],
  },
];

function precisionAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const expectedSet = new Set(expected);
  return topK.filter(id => expectedSet.has(id)).length / topK.length;
}

function reciprocalRank(results: string[], expected: string[]): number {
  const expectedSet = new Set(expected);
  const index = results.findIndex(id => expectedSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

async function evaluateCase(testCase: SearchCase) {
  const result = await runPipeline(articles, {
    label: testCase.queryLabel,
    description: 'Fixed search quality evaluation case',
    k1: 1.5,
    b: 0.75,
    lambda: 0,
    contextBonus: 1.2,
    keywords: testCase.keywords.map(keyword => ({ ...keyword, synonyms: keyword.synonyms ?? [] })),
  }, testCase.id, {
    archiveScoreThreshold: 0,
    noViewDays: 9999,
    resultLimit: 3,
  });

  const rankedIds = result.active.map(item => item.article.id);
  return {
    case: testCase.id,
    query: testCase.queryLabel,
    topResults: rankedIds,
    expectedTopIds: testCase.expectedTopIds,
    precisionAt1: precisionAtK(rankedIds, testCase.expectedTopIds, 1),
    reciprocalRank: reciprocalRank(rankedIds, testCase.expectedTopIds),
  };
}

const rows = [];
for (const testCase of cases) {
  rows.push(await evaluateCase(testCase));
}

const meanPrecisionAt1 = rows.reduce((sum, row) => sum + row.precisionAt1, 0) / rows.length;
const mrr = rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length;

console.table(rows.map(row => ({
  case: row.case,
  query: row.query,
  top1: row.topResults[0] ?? '',
  expected: row.expectedTopIds.join(', '),
  precisionAt1: row.precisionAt1.toFixed(3),
  reciprocalRank: row.reciprocalRank.toFixed(3),
})));
console.log(JSON.stringify({
  cases: rows.length,
  meanPrecisionAt1: Number(meanPrecisionAt1.toFixed(3)),
  mrr: Number(mrr.toFixed(3)),
}, null, 2));
