import fs from 'node:fs';
import path from 'node:path';
import { looksLikeMojibake, runPipeline, type Article } from '../bm25_engine.js';
import { tokenize } from '../search/tokenizer.js';
import { excludesArticle, parseSearchQuery, type ParsedSearchQuery } from '../search/query_parser.js';
import { assertSearchQualityMetrics, realQualityGateThresholds, searchQualityThresholds, type SearchQualityMetricName } from './search_quality_config.js';

type SearchCase = { id: string; query: string; keywords: Array<{ term: string; weight: number; synonyms?: string[] }>; expected: string[]; kind: string };
type Variant = { name: string; description: string; synonym: boolean; lambda: number };
type AnonymizedFixture = { version?: string; documents?: Array<{ id: string; title: string; body: string; url: string; sourceAuthority: number; publishedAt: string; tokens: string[]; morphologicalTokens?: string[]; docLength: number; archived?: boolean }> };
type ManualRealQuery = { id: string; query: string; expected: string[]; kind?: string };
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
  article('saved-old', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', '\u53e4\u3044\u8a18\u9332', ['\u4fdd\u5b58','\u6e08\u307f','\u30ab\u30fc\u30c9','\u30ed\u30fc\u30ab\u30eb','\u691c\u7d22','\u53e4\u3044','\u8a18\u9332','\u518d\u767a\u898B'], '2025-01-01'),
  article('saved-new', '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', '\u65b0\u3057\u3044\u8a18\u9332', ['\u4fdd\u5b58','\u6e08\u307f','\u30ab\u30fc\u30c9','\u30ed\u30fc\u30ab\u30eb','\u691c\u7d22','\u65b0\u3057\u3044','\u8a18\u9332','\u518d\u767a\u898B'], '2026-07-30'),
  article('jp-quality', '\u65e5\u672c\u8a9e\u691c\u7d22\u54c1\u8cea', '\u5206\u304b\u3061\u66f8\u304d\u3068\u6587\u5b57\u5316\u3051\u691c\u77e5\u3092\u691c\u8a3c\u3059\u308b\u3002', ['\u65e5\u672c\u8a9e','\u691c\u7d22','\u54c1\u8cea','\u5206\u304b\u3061\u66f8\u304d','\u6587\u5b57\u5316\u3051','\u691c\u77e5']),
  article('jp-import', '\u65e5\u672c\u8a9eCSV\u53d6\u308a\u8fbc\u307f', '\u65e5\u672c\u8a9e\u306e\u30c7\u30fc\u30bf\u3092CSV\u304b\u3089\u53d6\u308a\u8fbc\u3080\u3002', ['\u65e5\u672c\u8a9e','csv','\u30c7\u30fc\u30bf','\u53d6\u308a\u8fbc\u307f']),
  article('jp-links', '\u30ab\u30fc\u30c9\u30ea\u30f3\u30af\u3068\u30d0\u30c3\u30af\u30ea\u30f3\u30af', '\u77e5\u8b58\u30b0\u30e9\u30d5\u306e\u95a2\u4fc2\u3092\u8868\u793a\u3059\u308b\u3002', ['\u30ab\u30fc\u30c9','\u30ea\u30f3\u30af','\u30d0\u30c3\u30af\u30ea\u30f3\u30af','\u77e5\u8b58','\u30b0\u30e9\u30d5']),
  article('jp-dashboard', '\u65e5\u672c\u8a9e\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9', '\u8868\u793a\u306e\u30ec\u30a4\u30a2\u30a6\u30c8\u3068\u8272\u3092\u6539\u5584\u3059\u308b\u3002', ['\u65e5\u672c\u8a9e','\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9','\u8868\u793a','\u30ec\u30a4\u30a2\u30a6\u30c8','\u8272']),
  article('jp-job', '\u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9\u30b8\u30e7\u30d6\u306e\u5fa9\u65e7', '\u518d\u8d77\u52d5\u6642\u306b\u4e2d\u65ad\u30b8\u30e7\u30d6\u3092\u5931\u6557\u72b6\u614b\u306b\u3059\u308b\u3002', ['\u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9','\u30b8\u30e7\u30d6','\u5fa9\u65e7','\u518d\u8d77\u52d5','\u4e2d\u65ad']),
  article('jp-backup', '\u30ed\u30fc\u30ab\u30eb\u30d0\u30c3\u30af\u30a2\u30c3\u30d7', '\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9\u3092\u5b89\u5168\u306b\u30d0\u30c3\u30af\u30a2\u30c3\u30d7\u3059\u308b\u3002', ['\u30ed\u30fc\u30ab\u30eb','\u30d0\u30c3\u30af\u30a2\u30c3\u30d7','\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9','\u5b89\u5168']),
  article('jp-postgres', '\u30dd\u30b9\u30c8\u30b0\u30ecSQL\u79fb\u884c', '\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9\u3092\u79fb\u884c\u3059\u308b\u969b\u306e\u8a2d\u5b9a\u3092\u78ba\u8a8d\u3059\u308b\u3002', ['\u30dd\u30b9\u30c8\u30b0\u30ecSQL','\u79fb\u884c','\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9','\u8a2d\u5b9a']),
  ...Array.from({ length: 39 }, (_, index) => article(`noise-${index}`, `Unrelated document ${index}`, `Archive note ${index} about unrelated operations and maintenance.`, ['archive','operations','maintenance',`noise-${index}`], '2026-01-01', 0.2)),
];

const cases: SearchCase[] = [
  { id: 'bm25-cache', kind: 'clear-positive', query: 'BM25 token cache', keywords: [{ term: 'BM25', weight: 2, synonyms: ['ranking'] }, { term: 'token', weight: 1.5, synonyms: ['tokens_json'] }, { term: 'SQLite', weight: 1.2 }], expected: ['sqlite-bm25'] },
  { id: 'sqlite-persistence', kind: 'clear-positive', query: 'SQLite BM25 token caching', keywords: [{ term: 'SQLite', weight: 2 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 1.5 }], expected: ['sqlite-token-persistence','sqlite-bm25'] },
  { id: 'backlinks-graph', kind: 'clear-positive', query: 'card backlinks graph', keywords: [{ term: 'backlinks', weight: 2, synonyms: ['links'] }, { term: 'graph', weight: 1.5 }], expected: ['zettelkasten-links'] },
  { id: 'csv-validation', kind: 'clear-positive', query: 'CSV JSON validation', keywords: [{ term: 'CSV', weight: 1.5, synonyms: ['JSON'] }, { term: 'validation', weight: 2, synonyms: ['validate'] }], expected: ['csv-import'] },
  { id: 'dashboard-layout', kind: 'clear-positive', query: 'dashboard visual layout', keywords: [{ term: 'dashboard', weight: 2 }, { term: 'layout', weight: 1.5 }], expected: ['ui-polish'] },
  { id: 'jp-saved-search', kind: 'japanese-ambiguous', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22', keywords: [{ term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 2 }, { term: '\u30ed\u30fc\u30ab\u30eb\u691c\u7d22', weight: 1.5 }], expected: ['jp-search', 'saved-new', 'saved-old'] },
  { id: 'jp-quality', kind: 'japanese', query: '\u65e5\u672c\u8a9e\u691c\u7d22\u54c1\u8cea', keywords: [{ term: '\u65e5\u672c\u8a9e', weight: 2 }, { term: '\u691c\u7d22\u54c1\u8cea', weight: 1.5 }], expected: ['jp-quality'] },
  { id: 'jp-import', kind: 'japanese', query: '\u65e5\u672c\u8a9eCSV\u53d6\u308a\u8fbc\u307f', keywords: [{ term: '\u65e5\u672c\u8a9e', weight: 1.5 }, { term: 'CSV', weight: 1.5 }, { term: '\u53d6\u308a\u8fbc\u307f', weight: 2 }], expected: ['jp-import'] },
  { id: 'jp-links', kind: 'japanese', query: '\u30ab\u30fc\u30c9\u30ea\u30f3\u30af \u30d0\u30c3\u30af\u30ea\u30f3\u30af', keywords: [{ term: '\u30ab\u30fc\u30c9\u30ea\u30f3\u30af', weight: 1.5 }, { term: '\u30d0\u30c3\u30af\u30ea\u30f3\u30af', weight: 2 }], expected: ['jp-links'] },
  { id: 'jp-dashboard', kind: 'japanese', query: '\u65e5\u672c\u8a9e\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9\u8868\u793a', keywords: [{ term: '\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9', weight: 2 }, { term: '\u8868\u793a', weight: 1.5 }], expected: ['jp-dashboard'] },
  { id: 'jp-job', kind: 'japanese', query: '\u4e2d\u65ad\u30b8\u30e7\u30d6 \u518d\u8d77\u52d5', keywords: [{ term: '\u4e2d\u65ad\u30b8\u30e7\u30d6', weight: 2 }, { term: '\u518d\u8d77\u52d5', weight: 1.5 }], expected: ['jp-job'] },
  { id: 'jp-backup', kind: 'japanese', query: '\u30ed\u30fc\u30ab\u30eb\u30d0\u30c3\u30af\u30a2\u30c3\u30d7', keywords: [{ term: '\u30ed\u30fc\u30ab\u30eb', weight: 1.5 }, { term: '\u30d0\u30c3\u30af\u30a2\u30c3\u30d7', weight: 2 }], expected: ['jp-backup'] },
  { id: 'jp-postgres', kind: 'japanese', query: '\u30dd\u30b9\u30c8\u30b0\u30ecSQL\u79fb\u884c', keywords: [{ term: '\u30dd\u30b9\u30c8\u30b0\u30ecSQL', weight: 2 }, { term: '\u79fb\u884c', weight: 1.5 }], expected: ['jp-postgres'] },
  { id: 'jp-old-record', kind: 'japanese', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u53e4\u3044\u8a18\u9332', keywords: [{ term: '\u53e4\u3044\u8a18\u9332', weight: 2 }], expected: ['saved-old'] },
  { id: 'jp-new-record', kind: 'japanese', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u65b0\u3057\u3044\u8a18\u9332', keywords: [{ term: '\u65b0\u3057\u3044\u8a18\u9332', weight: 2 }], expected: ['saved-new'] },
  { id: 'near-negative', kind: 'near-negative', query: 'SQLite token persistence', keywords: [{ term: 'SQLite', weight: 2 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 2 }], expected: ['sqlite-token-persistence'] },
  { id: 'title-body-conflict', kind: 'title-body-conflict', query: 'SQLite token persistence', keywords: [{ term: 'SQLite', weight: 1 }, { term: 'token', weight: 2 }, { term: 'persistence', weight: 2 }], expected: ['sqlite-token-persistence'] },
  { id: 'long-document', kind: 'long-document', query: 'long document local search', keywords: [{ term: 'long', weight: 1.5 }, { term: 'document', weight: 1.5 }, { term: 'local', weight: 1 }, { term: 'search', weight: 1 }], expected: ['long-document'] },
  { id: 'time-decay', kind: 'time-decay-trap', query: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 \u30ed\u30fc\u30ab\u30eb\u691c\u7d22 \u518d\u767a\u898b', keywords: [{ term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 2 }, { term: '\u30ed\u30fc\u30ab\u30eb\u691c\u7d22', weight: 1.5 }, { term: '\u518d\u767a\u898b', weight: 1 }], expected: ['saved-new','saved-old'] },
  { id: 'parser-ambiguity', kind: 'parser-ambiguity', query: '"SQLite BM25" \u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9 -UI', keywords: [{ term: 'SQLite', weight: 1.5 }, { term: 'BM25', weight: 1.5 }, { term: '\u4fdd\u5b58\u6e08\u307f\u30ab\u30fc\u30c9', weight: 1 }], expected: ['sqlite-bm25'] },
];
type RealArticle = Article & { morphologicalTokens?: string[] };
function loadAnonymizedCorpus(): RealArticle[] {
  const fixturePath = path.join(process.cwd(), 'data', 'search-evaluation', 'anonymized-corpus.json');
  if (!fs.existsSync(fixturePath)) return [];
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as AnonymizedFixture;
  return (fixture.documents ?? []).filter(document => !document.archived).map(document => ({ ...document, publishedAt: new Date(document.publishedAt) }));
}
function buildRealProbeCases(corpus: RealArticle[]): SearchCase[] {
  const frequency = new Map<string, number>();
  const stopWords = new Set(['する', 'いる', 'ある', 'なる', 'こと', 'もの', 'ため', 'よう', 'できる', 'れる', 'られる', 'これ', 'それ', 'ここ', 'そこ']);
  for (const document of corpus) for (const token of new Set(document.morphologicalTokens ?? [])) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const usedQueries = new Set<string>();
  return corpus.map((document, index) => {
    const terms = [...new Set(document.morphologicalTokens ?? [])].filter(token => {
      const count = frequency.get(token) ?? 0;
      return token.length > 1 && !stopWords.has(token) && !/^[\u3040-\u30ff\u3400-\u9fff]{2}$/u.test(token) && !/^anon-|^匿名/.test(token) && count >= 2 && count <= Math.max(3, Math.floor(corpus.length * 0.4));
    }).sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) || b.length - a.length).slice(0, 2);
    const query = terms.join(' ');
    if (!query || usedQueries.has(query)) return null;
    usedQueries.add(query);
    return { id: `real-probe-${index}`, kind: 'real-auto-probe', query, keywords: terms.map(term => ({ term, weight: 1 })), expected: [document.id] };
  }).filter((testCase): testCase is SearchCase => testCase !== null).slice(0, 20);
}
function loadManualRealCases(): SearchCase[] {
  const queryPath = path.join(process.cwd(), 'data', 'search-evaluation', 'real-queries.json');
  if (!fs.existsSync(queryPath)) return [];
  const queries = JSON.parse(fs.readFileSync(queryPath, 'utf8')) as ManualRealQuery[];
  return queries.map(query => ({ id: query.id, kind: query.kind ?? 'real-manual', query: query.query, keywords: [], expected: query.expected }));
}
const realArticles = loadAnonymizedCorpus();
const manualRealCases = loadManualRealCases();
const realCases = manualRealCases.length > 0 ? manualRealCases : buildRealProbeCases(realArticles);
const realLabelSource = manualRealCases.length > 0 ? 'manual relevance labels from data/search-evaluation/real-queries.json' : 'auto-probed from common anonymized document tokens; not a release gate';
const variants: Variant[] = [
  { name: 'baseline', description: '実測窓の中央値', synonym: true, lambda: 0.085 },
  { name: 'no_synonym_expansion', description: '同義語展開を無効化した比較', synonym: false, lambda: 0.1 },
  { name: 'no_time_decay', description: '時間減衰を無効化した比較', synonym: true, lambda: 0 },
];
const synonymMap: Record<string, string[]> = { bm25: ['ranking'], token: ['tokens_json'], csv: ['json'], validation: ['validate'] };
function precisionAt(results: string[], expected: string[], k: number): number { const set = new Set(expected); return results.slice(0, k).filter(id => set.has(id)).length / Math.min(k, results.length || k); }
function rPrecision(results: string[], expected: string[]): number { const set = new Set(expected); const r = Math.max(expected.length, 1); return results.slice(0, r).filter(id => set.has(id)).length / r; }
function reciprocalRank(results: string[], expected: string[]): number { const set = new Set(expected); const index = results.findIndex(id => set.has(id)); return index < 0 ? 0 : 1 / (index + 1); }
function recallAt5(results: string[], expected: string[]): number { const set = new Set(expected); return results.slice(0, 5).filter(id => set.has(id)).length / set.size; }
function ndcgAt5(results: string[], expected: string[]): number { const set = new Set(expected); const dcg = results.slice(0, 5).reduce((sum, id, index) => sum + (set.has(id) ? 1 / Math.log2(index + 2) : 0), 0); const ideal = Array.from({ length: Math.min(5, set.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0); return ideal ? dcg / ideal : 0; }
function theoreticalUpperBounds(testCases: SearchCase[]): Record<SearchQualityMetricName, number> {
  const recallAt5 = testCases.reduce((sum, testCase) => sum + Math.min(1, 5 / Math.max(testCase.expected.length, 1)), 0) / testCases.length;
  return { precisionAt1: 1, rPrecision: 1, mrr: 1, recallAt5, ndcgAt5: 1 };
}
function assertMetricsWithinUpperBounds(scope: string, metrics: Record<string, number>, upperBounds: Record<string, number>): void {
  for (const [metric, actual] of Object.entries(metrics)) {
    const upperBound = upperBounds[metric];
    if (typeof upperBound === 'number' && actual > upperBound + 1e-9) {
      throw new Error(`${scope} ${metric}=${actual} exceeds theoretical upper bound ${upperBound}`);
    }
  }
}
async function evaluateVariant(variant: Variant, endToEnd: boolean, timeDecayFloor = 0.35, corpus: Article[] = articles, testCases: SearchCase[] = cases) {
  const rows = [];
  for (const testCase of testCases) {
    const parsed: ParsedSearchQuery | undefined = endToEnd ? parseSearchQuery(testCase.query, variant.synonym ? synonymMap : {}) : undefined;
    const keywords = parsed?.parsedKeywords ?? testCase.keywords.map(keyword => ({ ...keyword, synonyms: variant.synonym ? (keyword.synonyms ?? []) : [] }));
    const result = await runPipeline(corpus, { label: variant.name, description: endToEnd ? 'Raw query parser evaluation' : 'Keyword ranking evaluation', k1: 1.5, b: 0.75, lambda: variant.lambda, contextBonus: 1.2, keywords }, endToEnd ? 'end-to-end-query' : 'ranking-only', { archiveScoreThreshold: 2, dedupThreshold: 1, resultLimit: 5, timeDecayFloor });
    const eligible = result.active.filter(item => !parsed || !excludesArticle(item.article, parsed.excludedTerms));
    const ranked = eligible.map(item => item.article.id);
    const rankingDetails = eligible.map((item, index) => ({
      documentId: item.article.id,
      rank: index + 1,
      finalScore: Number(item.score.toFixed(6)),
      bm25Score: Number(item.breakdown.bm25Raw.toFixed(6)),
      contextBonus: Number(item.breakdown.contextBonus.toFixed(6)),
      timeDecayFactor: variant.lambda === 0 ? null : Number(item.breakdown.timeDecay.toFixed(6)),
      matchedTerms: item.breakdown.matchedTerms.map(term => ({
        term: term.term,
        contribution: Number((term.contribution * item.breakdown.contextBonus * item.breakdown.timeDecay).toFixed(6)),
      })),
      isExpected: testCase.expected.includes(item.article.id),
    }));
    const winner = rankingDetails[0];
    const runnerUp = rankingDetails[1];
    const sensitivity = winner && runnerUp && runnerUp.timeDecayFactor !== null && winner.timeDecayFactor !== null
      ? {
        runnerUpId: runnerUp.documentId,
        finalScoreGap: Number((winner.finalScore - runnerUp.finalScore).toFixed(6)),
        finalScoreGapRatio: winner.finalScore ? Number(((winner.finalScore - runnerUp.finalScore) / winner.finalScore).toFixed(6)) : 0,
        bm25ScoreGap: Number((winner.bm25Score - runnerUp.bm25Score).toFixed(6)),
        decayFactorGap: Number((winner.timeDecayFactor - runnerUp.timeDecayFactor).toFixed(6)),
        runnerUpBm25ToTie: Number((winner.finalScore / (runnerUp.contextBonus * runnerUp.timeDecayFactor)).toFixed(6)),
        runnerUpDecayToTie: Number((winner.finalScore / (runnerUp.bm25Score * runnerUp.contextBonus)).toFixed(6)),
        winnerDecayToLose: Number((runnerUp.finalScore / (winner.bm25Score * winner.contextBonus)).toFixed(6)),
      }
      : null;
    rows.push({ case: testCase.id, kind: testCase.kind, query: testCase.query, ...(endToEnd ? { rawQuery: testCase.query, parsedKeywords: keywords } : { rankingKeywords: keywords }), top1: ranked[0] ?? '', expected: testCase.expected, precisionAt1: precisionAt(ranked, testCase.expected, 1), rPrecision: rPrecision(ranked, testCase.expected), reciprocalRank: reciprocalRank(ranked, testCase.expected), recallAt5: recallAt5(ranked, testCase.expected), ndcgAt5: ndcgAt5(ranked, testCase.expected), sensitivity, rankingDetails });
  }
  return { variant: variant.name, rows, meanPrecisionAt1: rows.reduce((sum, row) => sum + row.precisionAt1, 0) / rows.length, meanRPrecision: rows.reduce((sum, row) => sum + row.rPrecision, 0) / rows.length, mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length, recallAt5: rows.reduce((sum, row) => sum + row.recallAt5, 0) / rows.length, ndcgAt5: rows.reduce((sum, row) => sum + row.ndcgAt5, 0) / rows.length };
}
function assessDatasetDiscrimination(metrics: Record<string, number>, theoretical: Record<string, number>, scope: string, labelSource: string, testCases: SearchCase[], rows: Array<{ query: string; expected: string[]; recallAt5: number }>) {
  const metricNames = ['precisionAt1', 'rPrecision', 'mrr', 'recallAt5', 'ndcgAt5'];
  const allMetricsAtUpperBound = metricNames.every(metric => typeof metrics[metric] === 'number' && typeof theoretical[metric] === 'number' && Math.abs(metrics[metric]! - theoretical[metric]!) <= 1e-9);
  const duplicateQueryGroups = [...new Set(testCases.map(testCase => testCase.query))].filter(query => testCases.filter(testCase => testCase.query === query).length > 1 && new Set(testCases.filter(testCase => testCase.query === query).map(testCase => testCase.expected.join('|'))).size > 1);
  const stopWords = new Set(['する', 'いる', 'ある', 'なる', 'こと', 'もの', 'ため', 'よう', 'できる', 'れる', 'られる']);
  const degenerateQueries = testCases.filter(testCase => testCase.query.split(/\s+/).filter(Boolean).every(token => stopWords.has(token) || /^[\u3040-\u30ff\u3400-\u9fff]{2}$/u.test(token))).length;
  const zeroRecallRate = rows.length > 0 ? rows.filter(row => row.recallAt5 === 0).length / rows.length : 0;
  const issues = [
    allMetricsAtUpperBound ? 'invalid-all-metrics-at-theoretical-upper-bound' : null,
    duplicateQueryGroups.length > 0 ? 'invalid-conflicting-duplicate-queries' : null,
    degenerateQueries / Math.max(testCases.length, 1) > 0.25 ? 'invalid-degenerate-query-language' : null,
    zeroRecallRate >= 0.75 ? 'invalid-low-signal' : null,
  ].filter((issue): issue is string => issue !== null);
  return { status: issues[0] ?? 'discriminative-signal-present', issues, allMetricsAtUpperBound, duplicateQueryGroups, degenerateQueryCount: degenerateQueries, zeroRecallRate, scope, labelSource, warning: issues.length > 0 ? 'データセットに識別不能なクエリ、矛盾した正解、または低信号が含まれる。品質ゲートへ昇格する前にラベルとクエリを見直すこと。' : null };
}
function artifact(evaluation: Awaited<ReturnType<typeof evaluateVariant>>, scope: string, pipeline: string[], corpus: Article[] = articles, testCases: SearchCase[] = cases) {
  const metrics = { precisionAt1: Number(evaluation.meanPrecisionAt1.toFixed(3)), rPrecision: Number(evaluation.meanRPrecision.toFixed(3)), mrr: Number(evaluation.mrr.toFixed(3)), recallAt5: Number(evaluation.recallAt5.toFixed(3)), ndcgAt5: Number(evaluation.ndcgAt5.toFixed(3)) };
  const theoretical = theoreticalUpperBounds(testCases);
  const labelSource = scope === 'real' ? realLabelSource : 'manual curated';
  return {
    scope,
    role: scope === 'end-to-end-query' ? 'primary-release-gate' : 'ranking-engine-diagnostic',
    qualityGate: scope === 'end-to-end-query' || scope === 'real',
    qualityGateThresholds: scope === 'real' ? realQualityGateThresholds : searchQualityThresholds,
    pipeline,
    dataset: { version: scope === 'real' ? (manualRealCases.length > 0 ? 'anonymized-card-corpus-v1-manual-queries' : 'anonymized-card-corpus-v1-common-token-probes') : 'v5-57-docs-20-query-cases', documents: corpus.length, queries: testCases.length, caseKinds: [...new Set(testCases.map(testCase => testCase.kind))], languages: ['English', 'Japanese'], labelSource },
    rows: evaluation.rows,
    metrics,
    theoretical,
    datasetQuality: assessDatasetDiscrimination(metrics, theoretical, scope, labelSource, testCases, evaluation.rows),
    thresholds: searchQualityThresholds,
    variants: [] as unknown[],
  };
}
const rankingEvaluations = []; const endToEndEvaluations = [];
for (const variant of variants) { rankingEvaluations.push(await evaluateVariant(variant, false)); endToEndEvaluations.push(await evaluateVariant(variant, true)); }
const ranking = artifact(rankingEvaluations[0], 'ranking-only', ['keywords', 'ranking_engine']); ranking.variants = rankingEvaluations.map(({ variant, rows: _rows, ...metrics }) => ({ name: variant, description: variants.find(item => item.name === variant)?.description ?? '', ...metrics }));
const endToEnd = artifact(endToEndEvaluations[0], 'end-to-end-query', ['raw_query', 'query_parser', 'keyword_candidates', 'ranking_engine']); endToEnd.variants = endToEndEvaluations.map(({ variant, rows: _rows, ...metrics }) => ({ name: variant, description: variants.find(item => item.name === variant)?.description ?? '', ...metrics }));
const real = realArticles.length > 0 && realCases.length > 0 ? artifact(await evaluateVariant(variants[0]!, true, 0.35, realArticles, realCases), 'real', ['anonymized_fixture', 'raw_query', 'query_parser', 'keyword_candidates', 'ranking_engine'], realArticles, realCases) : null;
type DecaySweepRow = {
  lambda: number;
  timeDecayFloor: number;
  precisionAt1: number;
  rPrecision: number;
  jpSavedSearchTop1: string;
  timeDecayTop1: string;
  parserAmbiguityTop1: string;
  bothPass: boolean;
  fullQualityPass: boolean;
};
const decaySweep: DecaySweepRow[] = [];
for (const timeDecayFloor of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
for (let index = 0; index <= 40; index += 1) {
  const lambda = Number((index * 0.005).toFixed(3));
  const evaluation = await evaluateVariant({ name: `lambda_${lambda}`, description: 'time-decay sweep', synonym: true, lambda }, true, timeDecayFloor);
  const jpSavedSearch = evaluation.rows.find((row) => row.case === 'jp-saved-search');
  const timeDecay = evaluation.rows.find((row) => row.case === 'time-decay');
  const parserAmbiguity = evaluation.rows.find((row) => row.case === 'parser-ambiguity');
  const qualityMetrics = {
    precisionAt1: evaluation.meanPrecisionAt1,
    rPrecision: evaluation.meanRPrecision,
    mrr: evaluation.mrr,
    recallAt5: evaluation.recallAt5,
    ndcgAt5: evaluation.ndcgAt5,
  };
  const qualityPass = Object.entries(searchQualityThresholds).every(([metric, threshold]) => {
    const actual = qualityMetrics[metric as keyof typeof qualityMetrics];
    return typeof actual === 'number' && actual >= threshold;
  });
  decaySweep.push({
    lambda,
    timeDecayFloor,
    precisionAt1: Number(evaluation.meanPrecisionAt1.toFixed(3)),
    rPrecision: Number(evaluation.meanRPrecision.toFixed(3)),
    jpSavedSearchTop1: jpSavedSearch?.top1 ?? '',
    timeDecayTop1: timeDecay?.top1 ?? '',
    parserAmbiguityTop1: parserAmbiguity?.top1 ?? '',
    bothPass: ['jp-search', 'saved-new', 'saved-old'].includes(jpSavedSearch?.top1 ?? '') && ['saved-new', 'saved-old'].includes(timeDecay?.top1 ?? ''),
    fullQualityPass: qualityPass,
  });
}
}
const passingDecayLambdas = decaySweep.filter((row) => row.bothPass).map((row) => row.lambda);
const passingDecayConfigs = decaySweep.filter((row) => row.bothPass);
const productionCandidates = decaySweep.filter((row) => row.bothPass && row.parserAmbiguityTop1 === 'sqlite-bm25' && row.fullQualityPass);
const selectedDecayConfig = productionCandidates.length > 0
  ? productionCandidates[Math.floor(productionCandidates.length / 2)]
  : null;
const decayRange = passingDecayConfigs.length > 0
  ? { minLambda: Math.min(...passingDecayConfigs.map((row) => row.lambda)), maxLambda: Math.max(...passingDecayConfigs.map((row) => row.lambda)), lambdaWidth: Number((Math.max(...passingDecayConfigs.map((row) => row.lambda)) - Math.min(...passingDecayConfigs.map((row) => row.lambda))).toFixed(3)), minFloor: Math.min(...passingDecayConfigs.map((row) => row.timeDecayFloor)), maxFloor: Math.max(...passingDecayConfigs.map((row) => row.timeDecayFloor)), floorWidth: Number((Math.max(...passingDecayConfigs.map((row) => row.timeDecayFloor)) - Math.min(...passingDecayConfigs.map((row) => row.timeDecayFloor))).toFixed(3)), step: 0.005, inclusive: true }
  : null;
const decayFloorProfiles = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5].map((timeDecayFloor) => {
  const rows = decaySweep.filter((row) => row.timeDecayFloor === timeDecayFloor);
  const passing = rows.filter((row) => row.bothPass);
  return {
    timeDecayFloor,
    pAt1ByLambda: rows.map((row) => ({ lambda: row.lambda, precisionAt1: row.precisionAt1, bothPass: row.bothPass, fullQualityPass: row.fullQualityPass })),
    passingRange: passing.length > 0 ? { minLambda: Math.min(...passing.map((row) => row.lambda)), maxLambda: Math.max(...passing.map((row) => row.lambda)), lambdaWidth: Number((Math.max(...passing.map((row) => row.lambda)) - Math.min(...passing.map((row) => row.lambda))).toFixed(3)), count: passing.length } : null,
  };
});
const tokenizerSource = fs.readFileSync(path.join(process.cwd(), 'bm25_engine.ts'), 'utf8');
const anonymizedFixturePath = path.join(process.cwd(), 'data', 'search-evaluation', 'anonymized-corpus.json');
let anonymizedCorpusSummary: { path: string; documents: number; activeDocuments: number; tokenCount: number; version: string } | null = null;
if (fs.existsSync(anonymizedFixturePath)) {
  const fixture = JSON.parse(fs.readFileSync(anonymizedFixturePath, 'utf8')) as { version?: string; documents?: Array<{ archived?: boolean; tokens?: string[] }> };
  const documents = fixture.documents ?? [];
  anonymizedCorpusSummary = { path: 'data/search-evaluation/anonymized-corpus.json', documents: documents.length, activeDocuments: documents.filter(document => !document.archived).length, tokenCount: documents.reduce((sum, document) => sum + (document.tokens?.length ?? 0), 0), version: fixture.version ?? 'unknown' };
}
const tokenizationDiagnostics = {
  implementation: [
    { file: 'search/tokenizer.ts', symbol: 'tokenize', role: 'search and document tokenization export' },
    { file: 'bm25_engine.ts', symbol: 'tokenizeText', role: 'kuromoji tokenization and normalization implementation', line: tokenizerSource.slice(0, tokenizerSource.indexOf('function tokenizeText')).split('\n').length },
    { file: 'search/query_parser.ts', symbol: 'parseSearchQuery', role: 'query splitting, phrase handling, and exclusions' },
  ],
  samples: await Promise.all([
    '保存済みカード ローカル検索',
    '保存済みカード',
    'SQLite BM25 token cache',
    '"SQLite BM25" 保存済みカード -UI',
  ].map(async query => ({ query, tokens: await tokenize(query) }))),
  storedTokenExamples: ['jp-search', 'saved-new'].map(id => ({ id, tokens: articles.find(item => item.id === id)?.tokens ?? [] })),
  checks: {
    japaneseNormalizationAndBigramPathPresent: /normalize|bigram|ngram/i.test(tokenizerSource),
    queryParserPresent: fs.existsSync(path.join(process.cwd(), 'search', 'query_parser.ts')),
    mojibakeDetectionPresent: /looksLikeMojibake|MOJIBAKE_PATTERNS/.test(tokenizerSource),
  },
  mojibakeSamples: ['保存済みカードの検索', '\uFFFD', 'Ã¦\u2013\u2022'].map((value) => ({ value, detected: looksLikeMojibake(value) })),
};
const failureCases = endToEnd.rows.filter(row => !row.expected.includes(row.top1)).map(row => ({ case: row.case, query: row.query, expected: row.expected, top1: row.top1, rankingDetails: row.rankingDetails }));
const diagnostic = { ...({ ranking, endToEnd, real }), anonymizedCorpus: anonymizedCorpusSummary, decaySweep: { lambdas: decaySweep, passingRange: decayRange, floorProfiles: decayFloorProfiles, productionCandidates, selected: selectedDecayConfig }, failureCases, successNearNegativeCases: endToEnd.rows.filter(row => row.kind === 'near-negative').map(row => ({ case: row.case, query: row.query, expected: row.expected, top1: row.top1, rankingDetails: row.rankingDetails })), tokenizationDiagnostics };
fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'ranking-engine-quality.json'), JSON.stringify(ranking, null, 2), 'utf-8');
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'end-to-end-query-quality.json'), JSON.stringify(endToEnd, null, 2), 'utf-8');
if (real) fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'real-search-quality.json'), JSON.stringify(real, null, 2), 'utf-8');
fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'search-quality.json'), JSON.stringify(diagnostic, null, 2), 'utf-8');
console.log(JSON.stringify({ ranking: { metrics: ranking.metrics, rows: ranking.rows.length }, endToEnd: { metrics: endToEnd.metrics, rows: endToEnd.rows.length }, real: real ? { metrics: real.metrics, rows: real.rows.length, qualityGate: real.qualityGate } : null, decayRange }, null, 2));
try {
  assertMetricsWithinUpperBounds('ranking', ranking.metrics, ranking.theoretical);
  assertMetricsWithinUpperBounds('endToEnd', endToEnd.metrics, endToEnd.theoretical);
  if (real) assertMetricsWithinUpperBounds('real', real.metrics, real.theoretical);
  assertSearchQualityMetrics('endToEnd', endToEnd.metrics);
  if (real && real.metrics.precisionAt1 < realQualityGateThresholds.precisionAt1) {
    throw new Error(`real precisionAt1=${real.metrics.precisionAt1} is below threshold ${realQualityGateThresholds.precisionAt1}`);
  }
  const defaultFloorProfile = decayFloorProfiles.find((profile) => profile.timeDecayFloor === 0.35);
  if (!defaultFloorProfile?.passingRange || defaultFloorProfile.passingRange.lambdaWidth <= 0) {
    throw new Error('time-decay floor 0.35 must retain a measurable non-zero passing window');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
