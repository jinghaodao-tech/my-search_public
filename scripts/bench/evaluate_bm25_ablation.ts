import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { allQueryTokenContextBonus, currentContextBonus, keywordUnitContextBonus } from './context_bonus.js';
import { rerankByTitleCoverage } from '../../services/title_rerank.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const datasetName = process.argv[2] ?? 'scifact';
const queryLimit = Math.max(1, Number(process.argv[3] ?? 100));
const option = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const dataDir = path.resolve(option('data-dir') ?? path.join(root, 'data', 'bench'));
const dataPath = path.join(dataDir, `${datasetName}.eval.json`);
const sourceDbPath = path.join(dataDir, `${datasetName}.db`);
if (!fs.existsSync(dataPath) || !fs.existsSync(sourceDbPath)) throw new Error(`Missing isolated benchmark dataset: ${datasetName}`);

const workDir = path.join(dataDir, 'work');
fs.mkdirSync(workDir, { recursive: true });
const workDbPath = path.join(workDir, `bm25-ablation-${datasetName}-${process.pid}.db`);
const { default: Database } = await import('better-sqlite3');
const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
await sourceDb.backup(workDbPath);
sourceDb.close();
process.env.DB_PATH = workDbPath;

const [{ db }, { loadArticlesFromDb }, { loadCards }, { discoverMode, purposeWords }, { analyzeQuery }, { tokenizeQuery, tokenizeMorphological, computeJapanesePhraseWeight }, { runPipeline }] = await Promise.all([
  import('../../db/database.js'),
  import('../../repositories/articles_repository.js'),
  import('../../repositories/cards_repository.js'),
  import('../../services/discover_service.js'),
  import('../../services/query_analysis.js'),
  import('../../bm25_engine.js'),
  import('../../search/bm25.js'),
]);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${workDbPath}${suffix}`, { force: true }); } catch { /* isolated temporary copy */ }
  }
});

type Query = { id: string; text: string };
type EvalData = { source: string; idPrefix: string; queries: Query[]; qrels: Record<string, Record<string, number>> };
type Article = ReturnType<typeof loadArticlesFromDb>[number];
type QuerySpec = {
  query: Query;
  mode: ReturnType<typeof discoverMode>;
  ngramTerms: string[];
  morphologicalTerms: string[];
  groups: string[][];
  keywordUnitGroups: string[][];
  keywordWeights: Map<string, number>;
  rarityWeights: Map<string, number>;
};
type Variant = {
  id: string;
  family: 'ablation' | 'signal' | 'standard' | 'combination';
  k1: number;
  b: number;
  bStrategy?: 'corpus-mean-morph-length';
  lambda: number;
  context: boolean;
  contextStrategy: 'current' | 'none' | 'all-query-tokens' | 'keyword-units';
  coverage: boolean;
  decay: boolean;
  rarity: boolean;
  termWeights: boolean;
  normalization: 'max' | 'none' | 'rrf';
  signal: 'both' | 'morphological' | 'ngram';
  candidatePolicy: 'shared-union' | 'signal-only';
};

const evalData = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as EvalData;
const queries = evalData.queries.slice(0, queryLimit);
const articleRows = loadArticlesFromDb();
const articles = articleRows.length ? articleRows : loadCards().filter(card => !card.archived).map(card => ({
  id: card.id,
  title: card.title,
  body: card.body,
  summary: card.summary,
  publishedAt: new Date(card.createdAt),
  createdAt: card.createdAt,
  updatedAt: card.updatedAt,
  sourceAuthority: 0.8,
  url: card.url ?? '',
  source: 'saved-card-benchmark',
  tags: card.tags,
  type: card.type,
  archived: card.archived,
  archivedAt: card.archivedAt,
  tokens: card.tokens,
  docLength: card.docLength,
  morphologicalTokens: card.morphologicalTokens,
  ngramTokens: card.ngramTokens,
  morphologicalDocLength: card.morphologicalDocLength,
  ngramDocLength: card.ngramDocLength,
}));
if (articles.length === 0) throw new Error(`No articles loaded from ${sourceDbPath}`);
const indexByDocumentId = new Map(articles.map((article, index) => [article.id.slice(evalData.idPrefix.length), index]));

const current = {
  k1: 1.2,
  b: 0.3,
  lambda: Math.LN2 / 730,
  context: true,
  coverage: true,
  decay: true,
  rarity: true,
  termWeights: true,
  normalization: 'max' as const,
};
const corpusMeanMorphLength = articles.reduce((sum, article) => sum + (article.morphologicalDocLength || article.morphologicalTokens?.length || 0), 0) / articles.length;
const allVariants: Variant[] = [
  { id: 'A0-current-custom', family: 'ablation', ...current, contextStrategy: 'current', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'B-no-context', family: 'ablation', ...current, context: false, contextStrategy: 'none', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'C-all-query-tokens', family: 'ablation', ...current, contextStrategy: 'all-query-tokens', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'D-keyword-units', family: 'ablation', ...current, contextStrategy: 'keyword-units', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A1-no-rarity', family: 'ablation', ...current, contextStrategy: 'current', rarity: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A3-no-coverage', family: 'ablation', ...current, contextStrategy: 'current', coverage: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A4-no-decay', family: 'ablation', ...current, contextStrategy: 'current', decay: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A5-morphological-only', family: 'signal', ...current, contextStrategy: 'current', signal: 'morphological', candidatePolicy: 'signal-only' },
  { id: 'A6-ngram-only', family: 'signal', ...current, contextStrategy: 'current', signal: 'ngram', candidatePolicy: 'signal-only' },
  { id: 'A7-raw-score-no-max-normalization', family: 'signal', ...current, contextStrategy: 'current', normalization: 'none', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A8-no-context-no-coverage', family: 'combination', ...current, context: false, contextStrategy: 'none', coverage: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A9-no-rarity-no-context', family: 'combination', ...current, rarity: false, context: false, contextStrategy: 'none', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A10-no-rarity-no-coverage', family: 'combination', ...current, rarity: false, coverage: false, contextStrategy: 'current', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A11-no-rarity-no-context-no-coverage', family: 'combination', ...current, rarity: false, context: false, contextStrategy: 'none', coverage: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'S0-standard-ngram-same-kb', family: 'standard', ...current, contextStrategy: 'none', lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'none', signal: 'ngram', candidatePolicy: 'signal-only' },
  { id: 'S1-standard-morph-same-kb', family: 'standard', ...current, contextStrategy: 'none', lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'none', signal: 'morphological', candidatePolicy: 'signal-only' },
  { id: 'S2-standard-ngram-k1.2-b0.75', family: 'standard', ...current, contextStrategy: 'none', b: 0.75, lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'none', signal: 'ngram', candidatePolicy: 'signal-only' },
  { id: 'S3-standard-morph-k1.2-b0.75', family: 'standard', ...current, contextStrategy: 'none', b: 0.75, lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'none', signal: 'morphological', candidatePolicy: 'signal-only' },
  { id: 'S8-standard-morph-corpus-adaptive-b', family: 'standard', ...current, bStrategy: 'corpus-mean-morph-length', contextStrategy: 'none', lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'none', signal: 'morphological', candidatePolicy: 'signal-only' },
  { id: 'S4-standard-dual-maxnorm-same-kb', family: 'combination', ...current, contextStrategy: 'none', lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'max', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'S5-standard-dual-maxnorm-k1.2-b0.75', family: 'combination', ...current, contextStrategy: 'none', b: 0.75, lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'max', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'S6-standard-dual-rrf-k60-same-kb', family: 'combination', ...current, contextStrategy: 'none', lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'rrf', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'S7-standard-dual-rrf-k60-b0.75', family: 'combination', ...current, contextStrategy: 'none', b: 0.75, lambda: 0, context: false, coverage: false, decay: false, rarity: false, termWeights: false, normalization: 'rrf', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A12-current-corpus-adaptive-b', family: 'combination', ...current, bStrategy: 'corpus-mean-morph-length', contextStrategy: 'current', signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A13-a8-standard-b0.75', family: 'combination', ...current, b: 0.75, context: false, contextStrategy: 'none', coverage: false, signal: 'both', candidatePolicy: 'shared-union' },
  { id: 'A14-a8-corpus-adaptive-b', family: 'combination', ...current, bStrategy: 'corpus-mean-morph-length', context: false, contextStrategy: 'none', coverage: false, signal: 'both', candidatePolicy: 'shared-union' },
];
const requestedVariants = option('variants')?.split(',').map(value => value.trim()).filter(Boolean);
const variants = requestedVariants
  ? allVariants.filter(variant => variant.id === 'A0-current-custom' || variant.id === 'S3-standard-morph-k1.2-b0.75' || requestedVariants.includes(variant.id))
  : allVariants;
if (!variants.some(variant => variant.id === 'A0-current-custom')) throw new Error('A0 baseline must be included');
const rrfConfigurations = [
  { id: 'A15-current-standard-rrf-k60', customWeight: 0.5 },
  { id: 'A16-custom-heavy-rrf-k60', customWeight: 0.75 },
  { id: 'A17-standard-heavy-rrf-k60', customWeight: 0.25 },
] as const;
const corpusAdaptiveRouterId = 'A18-corpus-length-ranker-router';
const fieldEvidenceRouterId = 'A19-query-field-evidence-router';
const fieldCoverageRouterId = 'A20-query-field-coverage-router';
const fieldFullCoverageRouterId = 'A21-query-field-full-coverage-router';
const standardTitleCoverageId = 'A22-standard-title-coverage-04';
const titleRerankConfigurations = [
  { id: 'A23-standard-title-coverage-02', baseId: 'S3-standard-morph-k1.2-b0.75', weight: 0.2 },
  { id: 'A27-standard-title-coverage-01', baseId: 'S3-standard-morph-k1.2-b0.75', weight: 0.1 },
  { id: 'A24-current-title-coverage-02', baseId: 'A0-current-custom', weight: 0.2 },
] as const;
const titleFusionConfigurations = [
  { id: 'A25-standard-current-title-rrf-50', standardWeight: 0.5 },
  { id: 'A26-standard-current-title-rrf-25', standardWeight: 0.25 },
] as const;
const metricsNames = ['ndcg10', 'recall100', 'mrr10', 'map100'] as const;

const prepStart = performance.now();
const querySpecs: QuerySpec[] = [];
for (const query of queries) {
  const terms = await purposeWords(query.text);
  const analyzed = analyzeQuery(query.text, terms, term => /[a-z0-9]/i.test(term) ? 3 : 2);
  const mode = discoverMode([], terms);
  mode.keywords = analyzed.keywords.map(keyword => ({ ...keyword, synonyms: [] }));
  const ngramTerms = [...new Set([
    ...mode.keywords.map(keyword => keyword.term.normalize('NFKC').toLowerCase().trim()).filter(Boolean),
    ...await tokenizeQuery(mode.keywords.map(keyword => keyword.term).join(' ')),
  ])];
  const morphologicalTerms = [...new Set([
    ...mode.keywords.map(keyword => keyword.term.normalize('NFKC').toLowerCase().trim()).filter(Boolean),
    ...await tokenizeMorphological(mode.keywords.map(keyword => keyword.term).join(' ')),
  ])];
  const groups = await Promise.all(mode.keywords.map(async keyword => [...new Set(await tokenizeQuery(keyword.term))]));
  const keywordUnitGroups = await Promise.all(mode.keywords.map(async keyword => {
    const tokens = [...new Set(await tokenizeMorphological(keyword.term))];
    const normalized = keyword.term.normalize('NFKC').toLowerCase().trim();
    return tokens.length ? tokens : normalized ? [normalized] : [];
  }));
  querySpecs.push({ query, mode, ngramTerms, morphologicalTerms, groups, keywordUnitGroups, keywordWeights: new Map(), rarityWeights: new Map() });
}

const ngramVocab = new Set(querySpecs.flatMap(spec => [...spec.ngramTerms, ...spec.groups.flat()]));
const morphologicalVocab = new Set(querySpecs.flatMap(spec => spec.morphologicalTerms));
const ngramPostings = new Map<string, Map<number, number>>([...ngramVocab].map(term => [term, new Map()]));
const morphologicalPostings = new Map<string, Map<number, number>>([...morphologicalVocab].map(term => [term, new Map()]));
let totalNgramLength = 0;
let totalMorphologicalLength = 0;
for (let docIndex = 0; docIndex < articles.length; docIndex += 1) {
  const article = articles[docIndex]!;
  const ngrams = article.ngramTokens?.length ? article.ngramTokens : article.tokens ?? [];
  const morph = article.morphologicalTokens ?? [];
  totalNgramLength += article.ngramDocLength || ngrams.length;
  totalMorphologicalLength += article.morphologicalDocLength || morph.length;
  const countNeeded = (tokens: string[], postings: Map<string, Map<number, number>>, vocabulary: Set<string>) => {
    const tf = new Map<string, number>();
    for (const token of tokens) if (vocabulary.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [term, count] of tf) postings.get(term)!.set(docIndex, count);
  };
  countNeeded(ngrams, ngramPostings, ngramVocab);
  countNeeded(morph, morphologicalPostings, morphologicalVocab);
}
const averageNgramLength = totalNgramLength / articles.length;
const averageMorphologicalLength = totalMorphologicalLength / articles.length;
const effectiveB = (variant: Variant) => variant.bStrategy === 'corpus-mean-morph-length'
  ? (averageMorphologicalLength < 40 ? 0.3 : 0.75)
  : variant.b;
for (const spec of querySpecs) {
  for (const keyword of spec.mode.keywords) {
    const tokens = await tokenizeQuery(keyword.term);
    const normalizedTerm = keyword.term.normalize('NFKC').toLowerCase().trim();
    const phraseWeight = tokens.length > 1 && tokens.some(token => /[\u3040-\u30ff\u3400-\u9fff]/u.test(token))
      ? computeJapanesePhraseWeight(keyword.weight, tokens.length)
      : keyword.weight;
    for (const token of new Set([normalizedTerm, ...tokens].filter(Boolean))) {
      const canonical = token;
      const df = ngramPostings.get(canonical)?.size ?? 0;
      const rarityWeight = Math.log((articles.length + 1) / (df + 1)) + 1;
      spec.keywordWeights.set(canonical, Math.max(spec.keywordWeights.get(canonical) ?? 0, phraseWeight));
      spec.rarityWeights.set(canonical, rarityWeight);
    }
  }
}
const commonPreparationMs = performance.now() - prepStart;

const dateStart = Date.now();
const evaluationAsOf = new Date('2026-10-20T00:00:00.000Z');
const totalRelevant = (qrels: Record<string, number>) => Object.values(qrels).filter(grade => grade > 0).length;
const dcg = (grades: number[]) => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
function metrics(ranking: number[], judged: Record<string, number>) {
  const relevant = Object.entries(judged).filter(([, grade]) => grade > 0);
  const ideal = relevant.map(([, grade]) => grade).sort((left, right) => right - left).slice(0, 10);
  const first = ranking.findIndex(index => (judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0) > 0);
  const rankedIds = ranking.slice(0, 100).map(index => articles[index]!.id.slice(evalData.idPrefix.length));
  let hitCount = 0;
  let precisionSum = 0;
  for (let rank = 0; rank < rankedIds.length; rank += 1) {
    if ((judged[rankedIds[rank]!] ?? 0) > 0) {
      hitCount += 1;
      precisionSum += hitCount / (rank + 1);
    }
  }
  const relevantFound = relevant.reduce((count, [id]) => count + (rankedIds.includes(id) ? 1 : 0), 0);
  return {
    ndcg10: ideal.length ? dcg(ranking.slice(0, 10).map(index => judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0)) / dcg(ideal) : 0,
    recall100: relevant.length ? relevantFound / relevant.length : 0,
    mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0,
    map100: relevant.length ? precisionSum / relevant.length : 0,
  };
}
function postingUnion(postings: Map<string, Map<number, number>>, terms: string[]) {
  const indices = new Set<number>();
  for (const term of new Set(terms)) for (const docIndex of postings.get(term)?.keys() ?? []) indices.add(docIndex);
  return indices;
}
function tfFor(tokens: string[], terms: string[]) {
  const wanted = new Set(terms);
  const tf = new Map<string, number>();
  for (const token of tokens) if (wanted.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}
function bm25(tf: Map<string, number>, terms: string[], postings: Map<string, Map<number, number>>, docCount: number, docLength: number, averageLength: number, k1: number, b: number, weights: Map<string, number>, rarityWeights: Map<string, number>, useTermWeights: boolean, useRarity: boolean) {
  let total = 0;
  for (const term of new Set(terms)) {
    const frequency = tf.get(term) ?? 0;
    if (!frequency) continue;
    const df = postings.get(term)?.size ?? 0;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const denominator = frequency + k1 * (1 - b + b * (docLength / Math.max(averageLength, 1)));
    const termWeight = (useTermWeights ? weights.get(term) ?? 1 : 1) * (useRarity ? rarityWeights.get(term) ?? 1 : 1);
    total += idf * (frequency * (k1 + 1) / denominator) * termWeight;
  }
  return total;
}
function percentile(values: number[], proportion: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)] ?? 0;
}
const elapsedByVariant = new Map([...variants.map(variant => variant.id), ...rrfConfigurations.map(config => config.id), corpusAdaptiveRouterId, fieldEvidenceRouterId, fieldCoverageRouterId, fieldFullCoverageRouterId, standardTitleCoverageId, ...titleRerankConfigurations.map(config => config.id), ...titleFusionConfigurations.map(config => config.id)].map(id => [id, [] as number[]]));
const queryResults = new Map([...variants.map(variant => variant.id), ...rrfConfigurations.map(config => config.id), corpusAdaptiveRouterId, fieldEvidenceRouterId, fieldCoverageRouterId, fieldFullCoverageRouterId, standardTitleCoverageId, ...titleRerankConfigurations.map(config => config.id), ...titleFusionConfigurations.map(config => config.id)].map(id => [id, [] as Array<Record<string, unknown>>]));
const sharedCandidateIdsByQuery = new Map<string, Set<string>>();
const baselineMemory = process.memoryUsage();
let peakRss = baselineMemory.rss;
let peakHeap = baselineMemory.heapUsed;
let oneTermMatchCount = 0;
let oneTermFullBonusCount = 0;
const contextEdgeExamples: Array<{ queryId: string; query: string; documentId: string; matchedTerms: string[]; termCount: number; contextMultiplier: number }> = [];
const sampler = setInterval(() => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}, 25);

for (let queryIndex = 0; queryIndex < querySpecs.length; queryIndex += 1) {
  const spec = querySpecs[queryIndex]!;
  const judged = evalData.qrels[spec.query.id] ?? {};
  const unionCandidates = postingUnion(ngramPostings, spec.ngramTerms);
  for (const index of postingUnion(morphologicalPostings, spec.morphologicalTerms)) unionCandidates.add(index);
  sharedCandidateIdsByQuery.set(spec.query.id, new Set([...unionCandidates].map(index => articles[index]!.id)));
  const relevantInSharedCandidateUnion = Object.entries(judged).filter(([id, grade]) => grade > 0 && unionCandidates.has(indexByDocumentId.get(id) ?? -1)).length;
  const features = new Map<number, {
    article: Article;
    ngramTokens: string[];
    ngramTf: Map<string, number>;
    morphTf: Map<string, number>;
  }>();
  for (const index of unionCandidates) {
    const article = articles[index]!;
    const ngramTokens = article.ngramTokens?.length ? article.ngramTokens : article.tokens ?? [];
    const ngramTf = tfFor(ngramTokens, [...new Set([...spec.ngramTerms, ...spec.groups.flat()])]);
    const morphTf = tfFor(article.morphologicalTokens ?? [], spec.morphologicalTerms);
    const matched = spec.ngramTerms.filter(term => (ngramTf.get(term) ?? 0) > 0);
    if (spec.ngramTerms.length > 1 && matched.length === 1) {
      oneTermMatchCount += 1;
      const multiplier = currentContextBonus(ngramTokens, matched, 1.2);
      if (multiplier >= 1.2 - 1e-12) {
        oneTermFullBonusCount += 1;
        if (contextEdgeExamples.length < 20) contextEdgeExamples.push({ queryId: spec.query.id, query: spec.query.text, documentId: article.id.slice(evalData.idPrefix.length), matchedTerms: matched, termCount: spec.ngramTerms.length, contextMultiplier: multiplier });
      }
    }
    features.set(index, { article, ngramTokens, ngramTf, morphTf });
  }
  const resultByVariant = new Map<string, { ranking: number[]; metrics: ReturnType<typeof metrics>; candidates: number[]; elapsedMs: number; scores: Array<{ index: number; score: number }> }>();

  for (const variant of variants) {
    const candidates = variant.candidatePolicy === 'shared-union'
      ? [...unionCandidates]
      : [...postingUnion(variant.signal === 'morphological' ? morphologicalPostings : ngramPostings, variant.signal === 'morphological' ? spec.morphologicalTerms : spec.ngramTerms)];
    const relevantInVariantCandidates = Object.entries(judged).filter(([id, grade]) => grade > 0 && candidates.includes(indexByDocumentId.get(id) ?? -1)).length;
    const started = performance.now();
    const scored: Array<{ index: number; score: number; morph: number; ngram: number }> = [];
    let maxMorph = 0;
    let maxNgram = 0;
    for (const index of candidates) {
      const feature = features.get(index)!;
      const b = effectiveB(variant);
      const ngramScore = bm25(feature.ngramTf, spec.ngramTerms, ngramPostings, articles.length, feature.article.ngramDocLength || feature.ngramTokens.length, averageNgramLength, variant.k1, b, spec.keywordWeights, spec.rarityWeights, variant.termWeights, variant.rarity);
      const morphScore = bm25(feature.morphTf, spec.morphologicalTerms, morphologicalPostings, articles.length, feature.article.morphologicalDocLength || feature.article.morphologicalTokens?.length || 0, averageMorphologicalLength, variant.k1, b, spec.keywordWeights, spec.rarityWeights, variant.termWeights, variant.rarity);
      maxMorph = Math.max(maxMorph, morphScore);
      maxNgram = Math.max(maxNgram, ngramScore);
      scored.push({ index, score: 0, morph: morphScore, ngram: ngramScore });
    }
    const effectiveCandidates = variant.signal === 'both' ? scored : scored.filter(row => variant.signal === 'morphological' ? row.morph > 0 : row.ngram > 0);
    const rankByMorph = variant.normalization === 'rrf'
      ? new Map([...scored].sort((left, right) => right.morph - left.morph || left.index - right.index).map((row, rank) => [row.index, rank + 1]))
      : undefined;
    const rankByNgram = variant.normalization === 'rrf'
      ? new Map([...scored].sort((left, right) => right.ngram - left.ngram || left.index - right.index).map((row, rank) => [row.index, rank + 1]))
      : undefined;
    const ranked = effectiveCandidates.map(row => {
      const weighted = variant.normalization === 'rrf'
        ? 1 / (60 + rankByMorph!.get(row.index)!) + 1 / (60 + rankByNgram!.get(row.index)!)
        : variant.normalization === 'max'
        ? (variant.signal === 'ngram' ? row.ngram / Math.max(maxNgram, 1e-30)
          : variant.signal === 'morphological' ? row.morph / Math.max(maxMorph, 1e-30)
            : 0.5 * row.morph / Math.max(maxMorph, 1e-30) + 0.5 * row.ngram / Math.max(maxNgram, 1e-30))
        : variant.signal === 'ngram' ? row.ngram
          : variant.signal === 'morphological' ? row.morph
            : 0.5 * row.morph + 0.5 * row.ngram;
      const article = articles[row.index]!;
      const feature = features.get(row.index)!;
      const matchedInArticle = spec.ngramTerms.filter(term => (feature.ngramTf.get(term) ?? 0) > 0);
      const ctx = variant.contextStrategy === 'current' ? currentContextBonus(feature.ngramTokens, matchedInArticle, 1.2)
        : variant.contextStrategy === 'all-query-tokens' ? allQueryTokenContextBonus(feature.ngramTokens, spec.ngramTerms, 1.2)
          : variant.contextStrategy === 'keyword-units' ? keywordUnitContextBonus(feature.ngramTokens, spec.keywordUnitGroups, 1.2)
            : 1;
      const matchedGroups = variant.coverage ? spec.groups.filter(group => group.length > 0 && group.every(term => (feature.ngramTf.get(term) ?? 0) > 0)).length : 0;
      const coverage = variant.coverage && spec.groups.length ? 1 + 0.5 * matchedGroups / spec.groups.length : 1;
      const published = article.publishedAt instanceof Date ? article.publishedAt.getTime() : new Date(article.publishedAt).getTime();
      const days = (evaluationAsOf.getTime() - published) / 86_400_000;
      const decay = variant.decay ? Math.max(0.5, Math.exp(-variant.lambda * days)) : 1;
      return { index: row.index, score: weighted * ctx * coverage * decay, morph: row.morph, ngram: row.ngram, context: ctx, coverage, decay };
    }).filter(row => row.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
    const elapsedMs = performance.now() - started;
    elapsedByVariant.get(variant.id)!.push(elapsedMs);
    const ranking = ranked.map(row => row.index);
    const metric = metrics(ranking, judged);
    const results = queryResults.get(variant.id)!;
    results.push({
      queryId: spec.query.id,
      query: spec.query.text,
      metrics: metric,
      candidateCount: candidates.length,
      returnedCount: ranked.length,
      judgedRelevantCount: totalRelevant(judged),
      relevantInSharedCandidateUnion,
      relevantInVariantCandidates,
      top10: option('compact') ? undefined : ranked.slice(0, 10).map(row => ({
        id: articles[row.index]!.id.slice(evalData.idPrefix.length),
        relevance: judged[articles[row.index]!.id.slice(evalData.idPrefix.length)] ?? 0,
        score: Number(row.score.toFixed(8)),
        bm25Morphological: Number(row.morph.toFixed(8)),
        bm25Ngram: Number(row.ngram.toFixed(8)),
        contextMultiplier: Number(row.context.toFixed(6)),
        coverageMultiplier: Number(row.coverage.toFixed(6)),
        timeDecay: Number(row.decay.toFixed(6)),
      })),
    });
    resultByVariant.set(variant.id, { ranking, metrics: metric, candidates, elapsedMs, scores: ranked.map(row => ({ index: row.index, score: row.score })) });
  }

  const standardTitleStarted = performance.now();
  const standardForTitle = resultByVariant.get('S3-standard-morph-k1.2-b0.75');
  if (!standardForTitle) throw new Error('A22 requires S3-standard-morph-k1.2-b0.75');
  const titleCandidates = standardForTitle.scores.slice(0, 1000);
  const titleReranked = rerankByTitleCoverage(titleCandidates.map(row => ({
    index: row.index,
    score: row.score,
    article: { title: articles[row.index]!.title },
  })), spec.morphologicalTerms, 0.4);
  const titleRanking = titleReranked.map(row => row.index);
  const titleMetric = metrics(titleRanking, judged);
  const standardTitleElapsedMs = standardForTitle.elapsedMs + performance.now() - standardTitleStarted;
  const titleRelevantCount = Object.entries(judged).filter(([id, grade]) => grade > 0
    && titleCandidates.some(candidate => articles[candidate.index]!.id.slice(evalData.idPrefix.length) === id)).length;
  queryResults.get(standardTitleCoverageId)!.push({
    queryId: spec.query.id,
    query: spec.query.text,
    metrics: titleMetric,
    candidateCount: titleCandidates.length,
    returnedCount: titleRanking.length,
    judgedRelevantCount: totalRelevant(judged),
    relevantInSharedCandidateUnion,
    relevantInVariantCandidates: titleRelevantCount,
    titleRerankWeight: 0.4,
    deltaVsStandard: Object.fromEntries(metricsNames.map(name => [name, titleMetric[name] - standardForTitle.metrics[name]])),
    top10JaccardVsStandard: (() => {
      const base = new Set(standardForTitle.ranking.slice(0, 10));
      const reranked = new Set(titleRanking.slice(0, 10));
      return base.size || reranked.size ? [...base].filter(index => reranked.has(index)).length / new Set([...base, ...reranked]).size : 1;
    })(),
    top10: option('compact') ? undefined : titleRanking.slice(0, 10).map(index => ({
      id: articles[index]!.id.slice(evalData.idPrefix.length),
      relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0,
    })),
  });
  elapsedByVariant.get(standardTitleCoverageId)!.push(standardTitleElapsedMs);
  resultByVariant.set(standardTitleCoverageId, { ranking: titleRanking, metrics: titleMetric, candidates: titleCandidates.map(row => row.index), elapsedMs: standardTitleElapsedMs, scores: titleReranked.map(row => ({ index: row.index, score: row.score })) });

  for (const config of titleRerankConfigurations) {
    const base = resultByVariant.get(config.baseId);
    if (!base) throw new Error(`${config.id} requires ${config.baseId}`);
    const rerankStarted = performance.now();
    const candidates = base.scores.slice(0, 1000);
    const reranked = rerankByTitleCoverage(candidates.map(row => ({
      index: row.index,
      score: row.score,
      article: { title: articles[row.index]!.title },
    })), spec.morphologicalTerms, config.weight);
    const ranking = reranked.map(row => row.index);
    const metric = metrics(ranking, judged);
    const elapsedMs = base.elapsedMs + performance.now() - rerankStarted;
    const relevantCount = Object.entries(judged).filter(([id, grade]) => grade > 0
      && candidates.some(candidate => articles[candidate.index]!.id.slice(evalData.idPrefix.length) === id)).length;
    queryResults.get(config.id)!.push({
      queryId: spec.query.id,
      query: spec.query.text,
      metrics: metric,
      candidateCount: candidates.length,
      returnedCount: ranking.length,
      judgedRelevantCount: totalRelevant(judged),
      relevantInSharedCandidateUnion,
      relevantInVariantCandidates: relevantCount,
      titleRerankWeight: config.weight,
      deltaVsBase: Object.fromEntries(metricsNames.map(name => [name, metric[name] - base.metrics[name]])),
      top10JaccardVsBase: (() => {
        const baseTop = new Set(base.ranking.slice(0, 10));
        const rerankedTop = new Set(ranking.slice(0, 10));
        return baseTop.size || rerankedTop.size ? [...baseTop].filter(index => rerankedTop.has(index)).length / new Set([...baseTop, ...rerankedTop]).size : 1;
      })(),
      top10: option('compact') ? undefined : reranked.slice(0, 10).map(row => ({
        id: articles[row.index]!.id.slice(evalData.idPrefix.length),
        relevance: judged[articles[row.index]!.id.slice(evalData.idPrefix.length)] ?? 0,
      })),
    });
    elapsedByVariant.get(config.id)!.push(elapsedMs);
    resultByVariant.set(config.id, { ranking, metrics: metric, candidates: candidates.map(row => row.index), elapsedMs, scores: reranked.map(row => ({ index: row.index, score: row.score })) });
  }

  for (const config of titleFusionConfigurations) {
    const standard = resultByVariant.get('S3-standard-morph-k1.2-b0.75');
    const customTitle = resultByVariant.get('A24-current-title-coverage-02');
    if (!standard || !customTitle) throw new Error(`${config.id} requires standard BM25 and A24`);
    const fusionStarted = performance.now();
    const reciprocalScores = new Map<number, number>();
    for (const [ranking, weight] of [[standard.ranking, config.standardWeight], [customTitle.ranking, 1 - config.standardWeight]] as const) {
      for (let rank = 0; rank < ranking.length; rank += 1) {
        const documentIndex = ranking[rank]!;
        reciprocalScores.set(documentIndex, (reciprocalScores.get(documentIndex) ?? 0) + weight / (60 + rank + 1));
      }
    }
    const fusedRanking = [...reciprocalScores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]).map(([index]) => index);
    const fusionMs = performance.now() - fusionStarted;
    const metric = metrics(fusedRanking.slice(0, 100), judged);
    const standardTop = new Set(standard.ranking.slice(0, 10));
    const fusedTop = new Set(fusedRanking.slice(0, 10));
    const relevantCount = Object.entries(judged).filter(([id, grade]) => grade > 0
      && reciprocalScores.has(indexByDocumentId.get(id) ?? -1)).length;
    queryResults.get(config.id)!.push({
      queryId: spec.query.id,
      query: spec.query.text,
      metrics: metric,
      candidateCount: reciprocalScores.size,
      returnedCount: fusedRanking.length,
      judgedRelevantCount: totalRelevant(judged),
      relevantInSharedCandidateUnion,
      relevantInVariantCandidates: relevantCount,
      deltaVsStandard: Object.fromEntries(metricsNames.map(name => [name, metric[name] - standard.metrics[name]])),
      top10JaccardVsStandard: standardTop.size || fusedTop.size ? [...standardTop].filter(index => fusedTop.has(index)).length / new Set([...standardTop, ...fusedTop]).size : 1,
      top10: option('compact') ? undefined : fusedRanking.slice(0, 10).map(index => ({
        id: articles[index]!.id.slice(evalData.idPrefix.length),
        relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0,
        score: reciprocalScores.get(index),
      })),
    });
    elapsedByVariant.get(config.id)!.push(fusionMs);
    resultByVariant.set(config.id, { ranking: fusedRanking, metrics: metric, candidates: [...reciprocalScores.keys()], elapsedMs: fusionMs, scores: fusedRanking.map(index => ({ index, score: reciprocalScores.get(index)! })) });
  }

  const customRanking = resultByVariant.get('A0-current-custom')!.ranking;
  const standardRanking = resultByVariant.get('S3-standard-morph-k1.2-b0.75')?.ranking;
  if (!standardRanking) throw new Error('A15 requires S3-standard-morph-k1.2-b0.75 in the selected variants');
  for (const config of rrfConfigurations) {
    const fusionStarted = performance.now();
    const reciprocalScores = new Map<number, number>();
    for (const [ranking, weight] of [[customRanking, config.customWeight], [standardRanking, 1 - config.customWeight]] as const) {
      for (let rank = 0; rank < ranking.length; rank += 1) {
        const documentIndex = ranking[rank]!;
        reciprocalScores.set(documentIndex, (reciprocalScores.get(documentIndex) ?? 0) + weight / (60 + rank + 1));
      }
    }
    const fusedRanking = [...reciprocalScores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]).map(([index]) => index);
    const fusionMs = performance.now() - fusionStarted;
    const fusionRows = queryResults.get(config.id)!;
    const customMetrics = resultByVariant.get('A0-current-custom')!.metrics;
    const fusedMetrics = metrics(fusedRanking.slice(0, 100), judged);
    const customTop = new Set(customRanking.slice(0, 10));
    const fusedTop = new Set(fusedRanking.slice(0, 10));
    fusionRows.push({
      queryId: spec.query.id,
      query: spec.query.text,
      metrics: fusedMetrics,
      candidateCount: reciprocalScores.size,
      returnedCount: fusedRanking.length,
      judgedRelevantCount: totalRelevant(judged),
      relevantInSharedCandidateUnion: Object.entries(judged).filter(([id, grade]) => grade > 0 && reciprocalScores.has(indexByDocumentId.get(id) ?? -1)).length,
      relevantInVariantCandidates: Object.entries(judged).filter(([id, grade]) => grade > 0 && reciprocalScores.has(indexByDocumentId.get(id) ?? -1)).length,
      deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, fusedMetrics[name] - customMetrics[name]])),
      top10JaccardVsA0: customTop.size || fusedTop.size ? [...customTop].filter(index => fusedTop.has(index)).length / new Set([...customTop, ...fusedTop]).size : 1,
      top10: option('compact') ? undefined : fusedRanking.slice(0, 10).map(index => ({ id: articles[index]!.id.slice(evalData.idPrefix.length), relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0, score: reciprocalScores.get(index) })),
    });
    elapsedByVariant.get(config.id)!.push(fusionMs);
  }

  const routedId = corpusMeanMorphLength < 40 ? 'A0-current-custom' : 'S3-standard-morph-k1.2-b0.75';
  const routed = resultByVariant.get(routedId);
  if (!routed) throw new Error(`A18 requires ${routedId}`);
  const routerRows = queryResults.get(corpusAdaptiveRouterId)!;
  const routedMetrics = routed.metrics;
  const customBaselineMetrics = resultByVariant.get('A0-current-custom')!.metrics;
  const routedTop = new Set(routed.ranking.slice(0, 10));
  const customTopForRouter = new Set(resultByVariant.get('A0-current-custom')!.ranking.slice(0, 10));
  routerRows.push({
    queryId: spec.query.id,
    query: spec.query.text,
    metrics: routedMetrics,
    candidateCount: routed.candidates.length,
    returnedCount: routed.ranking.length,
    judgedRelevantCount: totalRelevant(judged),
    relevantInSharedCandidateUnion: Object.entries(judged).filter(([id, grade]) => grade > 0 && routed.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    relevantInVariantCandidates: Object.entries(judged).filter(([id, grade]) => grade > 0 && routed.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    selectedRanker: routedId,
    deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, routedMetrics[name] - customBaselineMetrics[name]])),
    top10JaccardVsA0: customTopForRouter.size || routedTop.size ? [...customTopForRouter].filter(index => routedTop.has(index)).length / new Set([...customTopForRouter, ...routedTop]).size : 1,
    top10: option('compact') ? undefined : routed.ranking.slice(0, 10).map(index => ({ id: articles[index]!.id.slice(evalData.idPrefix.length), relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0 })),
  });
  elapsedByVariant.get(corpusAdaptiveRouterId)!.push(routed.elapsedMs);

  const fieldQueryTerms = spec.mode.keywords
    .map(keyword => keyword.term.normalize('NFKC').toLocaleLowerCase().trim())
    .filter(term => term.length >= 2);
  const customTopThree = resultByVariant.get('A0-current-custom')!.ranking.slice(0, 3);
  const hasTopFieldEvidence = customTopThree.some(index => {
    const article = articles[index]!;
    const searchableFields = [article.title, ...(Array.isArray(article.tags) ? article.tags : [])]
      .map(value => String(value).normalize('NFKC').toLocaleLowerCase());
    return fieldQueryTerms.some(term => searchableFields.some(field => field.includes(term)));
  });
  const fieldRouterId = hasTopFieldEvidence ? 'A0-current-custom' : 'S3-standard-morph-k1.2-b0.75';
  const fieldRouted = resultByVariant.get(fieldRouterId);
  if (!fieldRouted) throw new Error(`A19 requires ${fieldRouterId}`);
  const fieldRouterRows = queryResults.get(fieldEvidenceRouterId)!;
  const fieldRouterCustomBaseline = resultByVariant.get('A0-current-custom')!;
  const fieldRouterTop = new Set(fieldRouted.ranking.slice(0, 10));
  const fieldRouterBaselineTop = new Set(fieldRouterCustomBaseline.ranking.slice(0, 10));
  fieldRouterRows.push({
    queryId: spec.query.id,
    query: spec.query.text,
    metrics: fieldRouted.metrics,
    candidateCount: fieldRouted.candidates.length,
    returnedCount: fieldRouted.ranking.length,
    judgedRelevantCount: totalRelevant(judged),
    relevantInSharedCandidateUnion: Object.entries(judged).filter(([id, grade]) => grade > 0 && fieldRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    relevantInVariantCandidates: Object.entries(judged).filter(([id, grade]) => grade > 0 && fieldRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    selectedRanker: fieldRouterId,
    fieldEvidence: hasTopFieldEvidence,
    queryTermsChecked: fieldQueryTerms,
    deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, fieldRouted.metrics[name] - fieldRouterCustomBaseline.metrics[name]])),
    top10JaccardVsA0: fieldRouterBaselineTop.size || fieldRouterTop.size ? [...fieldRouterBaselineTop].filter(index => fieldRouterTop.has(index)).length / new Set([...fieldRouterBaselineTop, ...fieldRouterTop]).size : 1,
    top10: option('compact') ? undefined : fieldRouted.ranking.slice(0, 10).map(index => ({ id: articles[index]!.id.slice(evalData.idPrefix.length), relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0 })),
  });
  elapsedByVariant.get(fieldEvidenceRouterId)!.push(fieldRouted.elapsedMs);

  const keywordUnits = spec.mode.keywords.map(keyword => keyword.term.normalize('NFKC').toLocaleLowerCase().trim()).filter(Boolean);
  const maxFieldCoverage = Math.max(0, ...customTopThree.map(index => {
    const article = articles[index]!;
    const fields = [article.title, ...(Array.isArray(article.tags) ? article.tags : [])]
      .map(value => String(value).normalize('NFKC').toLocaleLowerCase());
    return Math.max(0, ...fields.map(field => keywordUnits.filter(unit => field.includes(unit)).length / Math.max(keywordUnits.length, 1)));
  }));
  const useCustomForFieldCoverage = maxFieldCoverage >= 0.5;
  const coverageRouterId = useCustomForFieldCoverage ? 'A0-current-custom' : 'S3-standard-morph-k1.2-b0.75';
  const coverageRouted = resultByVariant.get(coverageRouterId);
  if (!coverageRouted) throw new Error(`A20 requires ${coverageRouterId}`);
  const coverageRows = queryResults.get(fieldCoverageRouterId)!;
  const coverageBaseline = resultByVariant.get('A0-current-custom')!;
  const coverageTop = new Set(coverageRouted.ranking.slice(0, 10));
  const coverageBaseTop = new Set(coverageBaseline.ranking.slice(0, 10));
  coverageRows.push({
    queryId: spec.query.id,
    query: spec.query.text,
    metrics: coverageRouted.metrics,
    candidateCount: coverageRouted.candidates.length,
    returnedCount: coverageRouted.ranking.length,
    judgedRelevantCount: totalRelevant(judged),
    relevantInSharedCandidateUnion: Object.entries(judged).filter(([id, grade]) => grade > 0 && coverageRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    relevantInVariantCandidates: Object.entries(judged).filter(([id, grade]) => grade > 0 && coverageRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    selectedRanker: coverageRouterId,
    maxFieldKeywordCoverage: maxFieldCoverage,
    deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, coverageRouted.metrics[name] - coverageBaseline.metrics[name]])),
    top10JaccardVsA0: coverageBaseTop.size || coverageTop.size ? [...coverageBaseTop].filter(index => coverageTop.has(index)).length / new Set([...coverageBaseTop, ...coverageTop]).size : 1,
    top10: option('compact') ? undefined : coverageRouted.ranking.slice(0, 10).map(index => ({ id: articles[index]!.id.slice(evalData.idPrefix.length), relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0 })),
  });
  elapsedByVariant.get(fieldCoverageRouterId)!.push(coverageRouted.elapsedMs);

  const useCustomForFullCoverage = keywordUnits.length > 0 && maxFieldCoverage >= 1;
  const fullCoverageRouterId = useCustomForFullCoverage ? 'A0-current-custom' : 'S3-standard-morph-k1.2-b0.75';
  const fullCoverageRouted = resultByVariant.get(fullCoverageRouterId);
  if (!fullCoverageRouted) throw new Error(`A21 requires ${fullCoverageRouterId}`);
  const fullCoverageRows = queryResults.get(fieldFullCoverageRouterId)!;
  const fullCoverageTop = new Set(fullCoverageRouted.ranking.slice(0, 10));
  fullCoverageRows.push({
    queryId: spec.query.id,
    query: spec.query.text,
    metrics: fullCoverageRouted.metrics,
    candidateCount: fullCoverageRouted.candidates.length,
    returnedCount: fullCoverageRouted.ranking.length,
    judgedRelevantCount: totalRelevant(judged),
    relevantInSharedCandidateUnion: Object.entries(judged).filter(([id, grade]) => grade > 0 && fullCoverageRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    relevantInVariantCandidates: Object.entries(judged).filter(([id, grade]) => grade > 0 && fullCoverageRouted.candidates.includes(indexByDocumentId.get(id) ?? -1)).length,
    selectedRanker: fullCoverageRouterId,
    maxFieldKeywordCoverage: maxFieldCoverage,
    deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, fullCoverageRouted.metrics[name] - coverageBaseline.metrics[name]])),
    top10JaccardVsA0: coverageBaseTop.size || fullCoverageTop.size ? [...coverageBaseTop].filter(index => fullCoverageTop.has(index)).length / new Set([...coverageBaseTop, ...fullCoverageTop]).size : 1,
    top10: option('compact') ? undefined : fullCoverageRouted.ranking.slice(0, 10).map(index => ({ id: articles[index]!.id.slice(evalData.idPrefix.length), relevance: judged[articles[index]!.id.slice(evalData.idPrefix.length)] ?? 0 })),
  });
  elapsedByVariant.get(fieldFullCoverageRouterId)!.push(fullCoverageRouted.elapsedMs);

  const baseline = resultByVariant.get('A0-current-custom')!;
  for (const variant of variants) {
    const currentResult = resultByVariant.get(variant.id)!;
    const entry = queryResults.get(variant.id)!.at(-1)!;
    const currentMetrics = currentResult.metrics;
    const baseMetrics = baseline.metrics;
    (entry as { deltaVsA0?: Record<string, number>; top10JaccardVsA0?: number }).deltaVsA0 = {
      ndcg10: currentMetrics.ndcg10 - baseMetrics.ndcg10,
      recall100: currentMetrics.recall100 - baseMetrics.recall100,
      mrr10: currentMetrics.mrr10 - baseMetrics.mrr10,
      map100: currentMetrics.map100 - baseMetrics.map100,
    };
    const baseTop = new Set(baseline.ranking.slice(0, 10));
    const currentTop = new Set(currentResult.ranking.slice(0, 10));
    (entry as { top10JaccardVsA0?: number }).top10JaccardVsA0 = baseTop.size || currentTop.size
      ? [...baseTop].filter(index => currentTop.has(index)).length / new Set([...baseTop, ...currentTop]).size
      : 1;
  }
  if ((queryIndex + 1) % 10 === 0) console.error(`evaluated ${queryIndex + 1}/${querySpecs.length} queries for ${datasetName}`);
}
const referenceValidation: Array<{ queryId: string; exactTop10Match: boolean; top10Overlap: number; sameCandidateSet: boolean; evaluationCandidateCount: number; productionActiveCount: number; productionAfterDedupCount: number; returnedResultCount: number }> = [];
for (const spec of option('skip-reference') ? [] : querySpecs) {
  const reference = await runPipeline(articles, spec.mode, 'bm25-ablation-reference', {
    archiveScoreThreshold: -1,
    dedupThreshold: 1,
    resultLimit: 100,
    timeDecayFloor: 0.5,
  });
  const referenceIds = reference.active.map(item => item.article.id);
  const productionCandidateIds = new Set(articles
    .filter(article => (article.ngramTokens?.length ? article.ngramTokens : article.tokens ?? []).some(token => spec.ngramTerms.includes(token))
      || (article.morphologicalTokens ?? []).some(token => spec.morphologicalTerms.includes(token)))
    .map(article => article.id));
  const evaluatedIds = sharedCandidateIdsByQuery.get(spec.query.id)!;
  const reproducedIds = queryResults.get('A0-current-custom')!
    .find(row => row.queryId === spec.query.id)!
    .top10 as Array<{ id: string }>;
  const directTop10 = reproducedIds.map(item => `${evalData.idPrefix}${item.id}`);
  const referenceTop10 = referenceIds.slice(0, 10);
  const referenceTop10Set = new Set(referenceTop10);
  const overlap = [...new Set(directTop10)].filter(id => referenceTop10Set.has(id)).length;
  referenceValidation.push({
    queryId: spec.query.id,
    exactTop10Match: directTop10.length === referenceTop10.length && directTop10.every((id, index) => id === referenceTop10[index]),
    top10Overlap: overlap,
    sameCandidateSet: evaluatedIds.size === productionCandidateIds.size && [...productionCandidateIds].every(id => evaluatedIds.has(id))
      && reference.stats.afterDedup === articles.length && reference.stats.activeCount === evaluatedIds.size,
    evaluationCandidateCount: evaluatedIds.size,
    productionActiveCount: reference.stats.activeCount,
    productionAfterDedupCount: reference.stats.afterDedup,
    returnedResultCount: referenceIds.length,
  });
}
clearInterval(sampler);
const finalMemory = process.memoryUsage();
peakRss = Math.max(peakRss, finalMemory.rss);
peakHeap = Math.max(peakHeap, finalMemory.heapUsed);

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const summarize = (variant: Variant) => {
  const rows = queryResults.get(variant.id)!;
  const values = Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))]));
  const deltas = Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => ((row.deltaVsA0 as Record<string, number> | undefined)?.[name] ?? 0))).toFixed(4))]));
  return {
    ...values,
    deltaVsA0: variant.id === 'A0-current-custom' ? null : deltas,
    p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(variant.id)!, 0.5).toFixed(2)),
    p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(variant.id)!, 0.95).toFixed(2)),
    meanCandidateCount: Number(mean(rows.map(row => Number(row.candidateCount))).toFixed(1)),
    meanReturnedCount: Number(mean(rows.map(row => Number(row.returnedCount))).toFixed(1)),
    candidatePolicy: variant.candidatePolicy,
    parameters: {
      k1: variant.k1, b: effectiveB(variant), bStrategy: variant.bStrategy ?? 'fixed', lambda: variant.lambda, context: variant.context, coverage: variant.coverage,
      decay: variant.decay, rarity: variant.rarity, queryTermWeights: variant.termWeights,
      normalization: variant.normalization, signal: variant.signal,
    },
  };
};
const baselineRows = queryResults.get('A0-current-custom')!;
const rrfRowsById = new Map(rrfConfigurations.map(config => [config.id, queryResults.get(config.id)!]));
const rrfSummaries = Object.fromEntries(rrfConfigurations.map(config => {
  const rows = rrfRowsById.get(config.id)!;
  return [config.id, {
    ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
    deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => ((row.deltaVsA0 as Record<string, number>)[name]))).toFixed(4))])),
    p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.5).toFixed(2)),
    p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.95).toFixed(2)),
    meanCandidateCount: Number(mean(rows.map(row => Number(row.candidateCount))).toFixed(1)),
    meanReturnedCount: Number(mean(rows.map(row => Number(row.returnedCount))).toFixed(1)),
    candidatePolicy: 'union of complete A0 and S3 rankings; no fixed top-N truncation before RRF',
    parameters: { method: 'weighted RRF', k: 60, customWeight: config.customWeight, standardWeight: 1 - config.customWeight, inputs: ['A0-current-custom', 'S3-standard-morph-k1.2-b0.75'] },
  }];
}));
const routerRows = queryResults.get(corpusAdaptiveRouterId)!;
const routerSummary = {
  ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(routerRows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
  deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, Number(mean(routerRows.map(row => ((row.deltaVsA0 as Record<string, number>)[name]))).toFixed(4))])),
  p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(corpusAdaptiveRouterId)!, 0.5).toFixed(2)),
  p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(corpusAdaptiveRouterId)!, 0.95).toFixed(2)),
  meanCandidateCount: Number(mean(routerRows.map(row => Number(row.candidateCount))).toFixed(1)),
  meanReturnedCount: Number(mean(routerRows.map(row => Number(row.returnedCount))).toFixed(1)),
  candidatePolicy: 'corpus-level router; selects A0 if mean morphology length < 40, otherwise S3',
  parameters: { threshold: 40, corpusMeanMorphLength: Number(corpusMeanMorphLength.toFixed(2)), shortCorpusRanker: 'A0-current-custom', longCorpusRanker: 'S3-standard-morph-k1.2-b0.75', status: 'post-hoc exploratory heuristic' },
};
const fieldRouterRows = queryResults.get(fieldEvidenceRouterId)!;
const fieldRouterSummary = {
  ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(fieldRouterRows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
  deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, Number(mean(fieldRouterRows.map(row => ((row.deltaVsA0 as Record<string, number>)[name]))).toFixed(4))])),
  p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldEvidenceRouterId)!, 0.5).toFixed(2)),
  p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldEvidenceRouterId)!, 0.95).toFixed(2)),
  meanCandidateCount: Number(mean(fieldRouterRows.map(row => Number(row.candidateCount))).toFixed(1)),
  meanReturnedCount: Number(mean(fieldRouterRows.map(row => Number(row.returnedCount))).toFixed(1)),
  candidatePolicy: 'query-level router; select A0 if any exact analyzed keyword substring occurs in title/tags among A0 top 3, else S3',
  parameters: { topN: 3, exactFieldSubstring: true, minimumKeywordLength: 2, status: 'predefined exploratory heuristic; no per-query outcome used' },
};
const coverageRouterRows = queryResults.get(fieldCoverageRouterId)!;
const coverageRouterSummary = {
  ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(coverageRouterRows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
  deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, Number(mean(coverageRouterRows.map(row => ((row.deltaVsA0 as Record<string, number>)[name]))).toFixed(4))])),
  p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldCoverageRouterId)!, 0.5).toFixed(2)),
  p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldCoverageRouterId)!, 0.95).toFixed(2)),
  meanCandidateCount: Number(mean(coverageRouterRows.map(row => Number(row.candidateCount))).toFixed(1)),
  meanReturnedCount: Number(mean(coverageRouterRows.map(row => Number(row.returnedCount))).toFixed(1)),
  candidatePolicy: 'query-level router; select A0 if >=50% of analyzed keyword units appear as exact substrings in one title/tag among A0 top 3, else S3',
  parameters: { topN: 3, minimumFieldKeywordCoverage: 0.5, exactFieldSubstring: true, status: 'fixed before this run; exploratory' },
};
const fullCoverageRouterRows = queryResults.get(fieldFullCoverageRouterId)!;
const fullCoverageRouterSummary = {
  ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(fullCoverageRouterRows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
  deltaVsA0: Object.fromEntries(metricsNames.map(name => [name, Number(mean(fullCoverageRouterRows.map(row => ((row.deltaVsA0 as Record<string, number>)[name]))).toFixed(4))])),
  p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldFullCoverageRouterId)!, 0.5).toFixed(2)),
  p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(fieldFullCoverageRouterId)!, 0.95).toFixed(2)),
  meanCandidateCount: Number(mean(fullCoverageRouterRows.map(row => Number(row.candidateCount))).toFixed(1)),
  meanReturnedCount: Number(mean(fullCoverageRouterRows.map(row => Number(row.returnedCount))).toFixed(1)),
  customRankerSelectedQueries: fullCoverageRouterRows.filter(row => row.selectedRanker === 'A0-current-custom').length,
  candidatePolicy: 'query-level router; select A0 only if every analyzed keyword unit is an exact substring in one title/tag among A0 top 3, else S3',
  parameters: { topN: 3, minimumFieldKeywordCoverage: 1, exactFieldSubstring: true, status: 'fixed before this run; exploratory' },
};
const standardTitleRows = queryResults.get(standardTitleCoverageId)!;
const standardTitleSummary = {
  ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(standardTitleRows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
  deltaVsStandard: Object.fromEntries(metricsNames.map(name => [name, Number(mean(standardTitleRows.map(row => ((row.deltaVsStandard as Record<string, number>)[name]))).toFixed(4))])),
  p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(standardTitleCoverageId)!, 0.5).toFixed(2)),
  p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(standardTitleCoverageId)!, 0.95).toFixed(2)),
  meanCandidateCount: Number(mean(standardTitleRows.map(row => Number(row.candidateCount))).toFixed(1)),
  meanReturnedCount: Number(mean(standardTitleRows.map(row => Number(row.returnedCount))).toFixed(1)),
  candidatePolicy: 'exact standard morphology BM25 S3 top 1000 candidates, then title keyword coverage rerank',
  parameters: { baseRanker: 'S3-standard-morph-k1.2-b0.75', titleCoverageWeight: 0.4, queryTerms: 'same shared analyzed morphology query terms', status: 'fixed from BEIR development; app-corpus transfer diagnostic' },
};
const titleRerankSummaries = Object.fromEntries(titleRerankConfigurations.map(config => {
  const rows = queryResults.get(config.id)!;
  return [config.id, {
    ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
    deltaVsBase: Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => ((row.deltaVsBase as Record<string, number>)[name]))).toFixed(4))])),
    p50ScoreAndRankMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.5).toFixed(2)),
    p95ScoreAndRankMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.95).toFixed(2)),
    meanCandidateCount: Number(mean(rows.map(row => Number(row.candidateCount))).toFixed(1)),
    meanReturnedCount: Number(mean(rows.map(row => Number(row.returnedCount))).toFixed(1)),
    candidatePolicy: `top 1000 candidates from ${config.baseId}, then title keyword coverage rerank`,
    parameters: { baseRanker: config.baseId, titleCoverageWeight: config.weight, queryTerms: 'same shared analyzed morphology query terms', status: 'fixed app default; transfer diagnostic' },
  }];
}));
const titleFusionSummaries = Object.fromEntries(titleFusionConfigurations.map(config => {
  const rows = queryResults.get(config.id)!;
  return [config.id, {
    ...Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => (row.metrics as Record<string, number>)[name])).toFixed(4))])),
    deltaVsStandard: Object.fromEntries(metricsNames.map(name => [name, Number(mean(rows.map(row => ((row.deltaVsStandard as Record<string, number>)[name]))).toFixed(4))])),
    p50FusionOnlyMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.5).toFixed(2)),
    p95FusionOnlyMs: Number(percentile(elapsedByVariant.get(config.id)!, 0.95).toFixed(2)),
    meanCandidateCount: Number(mean(rows.map(row => Number(row.candidateCount))).toFixed(1)),
    meanReturnedCount: Number(mean(rows.map(row => Number(row.returnedCount))).toFixed(1)),
    candidatePolicy: 'full standard S3 ranking and all A24 results (A0 top 1000 candidates) fused by weighted RRF; no additional fusion cutoff',
    parameters: { method: 'weighted reciprocal rank fusion', k: 60, standardWeight: config.standardWeight, currentTitleWeight: 1 - config.standardWeight, fusionTimingExcludesBaseRankers: true },
  }];
}));
const changes = Object.fromEntries(variants.filter(variant => variant.id !== 'A0-current-custom').map(variant => {
  const rows = queryResults.get(variant.id)!;
  const paired = rows.map((row, index) => ({
    queryId: row.queryId,
    query: row.query,
    deltaNdcg10: Number((((row.deltaVsA0 as Record<string, number>).ndcg10)).toFixed(6)),
    deltaMrr10: Number((((row.deltaVsA0 as Record<string, number>).mrr10)).toFixed(6)),
    top10JaccardVsA0: row.top10JaccardVsA0,
    base: baselineRows[index],
    variant: row,
  }));
  const improved = paired.filter(row => row.deltaNdcg10 > 0).sort((left, right) => right.deltaNdcg10 - left.deltaNdcg10).slice(0, 5);
  const worsened = paired.filter(row => row.deltaNdcg10 < 0).sort((left, right) => left.deltaNdcg10 - right.deltaNdcg10).slice(0, 5);
  return [variant.id, { improved, worsened, unchangedNdcgQueries: paired.filter(row => row.deltaNdcg10 === 0).length, unchangedTop10Queries: paired.filter(row => row.top10JaccardVsA0 === 1).length }];
}));

const output = {
  generatedAt: new Date().toISOString(),
  dataset: datasetName,
  documents: articles.length,
  evaluatedQueries: queries.length,
  labelSource: 'isolated imported public qrels subset; not an official full-corpus leaderboard evaluation',
  evaluationAsOf: evaluationAsOf.toISOString(),
  corpusMeanMorphLength: Number(corpusMeanMorphLength.toFixed(2)),
  commonQueryAnalysis: 'purposeWords + discoverMode + analyzeQuery applied once per query and shared across all ranking variants; stored morphology and ngram tokens reused',
  deduplication: 'disabled consistently (threshold 1) to preserve one fixed candidate document set for ablations',
  benchmarkScope: 'A-D co-occurrence variants and A1-A4/A7 use the same shared morphology/ngram candidate union; A5/A6 and standard token-specific modes use signal-only candidates, so their candidate coverage is reported separately.',
  contextBonusDefinitions: {
    A: 'Legacy definition: denominator is the terms present in the document; a single matched term can therefore receive the maximum multiplier.',
    B: 'No co-occurrence multiplier (1.0).',
    C: 'Maximum distinct query ngram terms in a 50-token window divided by all unique analyzed ngram query terms. Overlapping Japanese ngrams remain distinct signals, so the expansion ratio is reported per query.',
    D: 'Original keyword units are each analyzed with the morphological tokenizer. A unit counts only if every distinct token in that unit occurs in the same 50-token window; partial unit matches count zero. The denominator is the number of non-empty original keyword units.',
    calculation: 'All variants use a sliding-window counter. A vs D calculation time includes per-window term/group counters; it excludes parsing and DB access.',
  },
  tokenExpansion: {
    description: 'Unique analyzed ngram terms divided by non-empty original keyword units; high values indicate Japanese N-gram representation expansion and potential denominator dilution in C.',
    meanNgramTermsPerQuery: Number(mean(querySpecs.map(spec => spec.ngramTerms.length)).toFixed(2)),
    meanKeywordUnitsPerQuery: Number(mean(querySpecs.map(spec => spec.keywordUnitGroups.filter(group => group.length > 0).length)).toFixed(2)),
    meanExpansionRatio: Number(mean(querySpecs.map(spec => spec.ngramTerms.length / Math.max(spec.keywordUnitGroups.filter(group => group.length > 0).length, 1))).toFixed(3)),
    perQuery: querySpecs.map(spec => ({ queryId: spec.query.id, query: spec.query.text, uniqueNgramTerms: spec.ngramTerms.length, originalKeywordUnits: spec.keywordUnitGroups.filter(group => group.length > 0).length, expansionRatio: Number((spec.ngramTerms.length / Math.max(spec.keywordUnitGroups.filter(group => group.length > 0).length, 1)).toFixed(3)) })),
  },
  dateLimitation: 'The importer assigns 2026-01-01 to every document. Decay therefore contributes the same multiplier to every document and cannot evaluate freshness ordering on these datasets.',
  uniquePublishedAtValues: new Set(articles.map(article => article.publishedAt instanceof Date ? article.publishedAt.toISOString() : String(article.publishedAt))).size,
  contextOneMatchAudit: {
    definition: 'Among shared-union candidate documents for queries with multiple analyzed ngram terms, count documents with exactly one matching term that nevertheless receive the maximum 1.2 context multiplier.',
    documentsWithOneMatchedTerm: oneTermMatchCount,
    documentsReceivingMaximumMultiplier: oneTermFullBonusCount,
    rate: oneTermMatchCount ? Number((oneTermFullBonusCount / oneTermMatchCount).toFixed(4)) : 0,
    examples: contextEdgeExamples,
  },
  timingScope: 'In-memory candidate scoring plus top-100 sort only; excludes database load, corpus/postings construction, query parsing and API serialization. Process RSS/heap are cumulative high-water marks, not per-variant deltas.',
  commonPreparationMs: Number(commonPreparationMs.toFixed(2)),
  referenceValidation: {
    description: option('skip-reference')
      ? 'Skipped by explicit --skip-reference: this run compares isolated ranking formulas and does not claim production runPipeline parity.'
      : 'A0 top-10 and shared candidate ID set compared with production runPipeline for every fixed query in this evaluation run.',
    exactTop10Matches: referenceValidation.filter(result => result.exactTop10Match).length,
    exactCandidateSetMatches: referenceValidation.filter(result => result.sameCandidateSet).length,
    checkedQueries: referenceValidation.length,
    rows: referenceValidation,
  },
  memoryMiB: {
    baselineRss: Number((baselineMemory.rss / 1024 ** 2).toFixed(1)),
    peakObservedRss: Number((peakRss / 1024 ** 2).toFixed(1)),
    peakObservedHeapUsed: Number((peakHeap / 1024 ** 2).toFixed(1)),
    finalRss: Number((finalMemory.rss / 1024 ** 2).toFixed(1)),
    finalHeapUsed: Number((finalMemory.heapUsed / 1024 ** 2).toFixed(1)),
  },
  variants: { ...Object.fromEntries(variants.map(variant => [variant.id, summarize(variant)])), ...rrfSummaries, [corpusAdaptiveRouterId]: routerSummary, [fieldEvidenceRouterId]: fieldRouterSummary, [fieldCoverageRouterId]: coverageRouterSummary, [fieldFullCoverageRouterId]: fullCoverageRouterSummary, [standardTitleCoverageId]: standardTitleSummary, ...titleRerankSummaries, ...titleFusionSummaries },
  perQuery: { ...Object.fromEntries(variants.map(variant => [variant.id, queryResults.get(variant.id)])), ...Object.fromEntries(rrfRowsById), [corpusAdaptiveRouterId]: routerRows, [fieldEvidenceRouterId]: fieldRouterRows, [fieldCoverageRouterId]: coverageRouterRows, [fieldFullCoverageRouterId]: fullCoverageRouterRows, [standardTitleCoverageId]: standardTitleRows, ...Object.fromEntries(titleRerankConfigurations.map(config => [config.id, queryResults.get(config.id)])), ...Object.fromEntries(titleFusionConfigurations.map(config => [config.id, queryResults.get(config.id)])) },
  largestQueryChanges: changes,
  candidateRecall: { ...Object.fromEntries(variants.map(variant => [variant.id, Number(mean(queryResults.get(variant.id)!.map(row => {
    const qrelCount = Number(row.judgedRelevantCount);
    return qrelCount ? Number(row.relevantInVariantCandidates) / qrelCount : 0;
  })).toFixed(4))])), [standardTitleCoverageId]: Number(mean(standardTitleRows.map(row => Number(row.relevantInVariantCandidates) / Math.max(Number(row.judgedRelevantCount), 1))).toFixed(4)), ...Object.fromEntries(titleRerankConfigurations.map(config => [config.id, Number(mean(queryResults.get(config.id)!.map(row => Number(row.relevantInVariantCandidates) / Math.max(Number(row.judgedRelevantCount), 1))).toFixed(4))])), ...Object.fromEntries(titleFusionConfigurations.map(config => [config.id, Number(mean(queryResults.get(config.id)!.map(row => Number(row.relevantInVariantCandidates) / Math.max(Number(row.judgedRelevantCount), 1))).toFixed(4))])) },
};

const outPath = path.resolve(option('output') ?? path.join(root, 'artifacts', `bm25-ablation-${datasetName}-${new Date().toISOString().slice(0, 10)}.json`));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ dataset: datasetName, documents: articles.length, queries: queries.length, commonPreparationMs: output.commonPreparationMs, output: outPath, variants: output.variants, memoryMiB: output.memoryMiB }, null, 2));
