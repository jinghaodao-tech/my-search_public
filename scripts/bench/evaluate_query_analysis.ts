import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const datasetName = process.argv[2] ?? 'scifact';
const queryLimit = Math.max(1, Number(process.argv[3] ?? 100));
const parseOnly = process.argv.includes('--parse-only');
const dbPath = path.join(root, 'data', 'bench', `${datasetName}.db`);
const evalPath = path.join(root, 'data', 'bench', `${datasetName}.eval.json`);
if (!fs.existsSync(dbPath) || !fs.existsSync(evalPath)) throw new Error(`Missing isolated benchmark dataset: ${datasetName}`);
const workDir = path.join(root, 'data', 'bench', 'work');
fs.mkdirSync(workDir, { recursive: true });
const workDbPath = path.join(workDir, `query-analysis-${datasetName}-${process.pid}.db`);
const { default: Database } = await import('better-sqlite3');
const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
await sourceDb.backup(workDbPath);
sourceDb.close();
process.env.DB_PATH = workDbPath;

const [{ loadArticlesFromDb }, { runPipeline, tokenizeNouns }, { purposeWords }, { analyzeQuery, GENERIC_TERMS }] = await Promise.all([
  import('../../repositories/articles_repository.js'),
  import('../../bm25_engine.js'),
  import('../../services/discover_service.js'),
  import('../../services/query_analysis.js'),
]);
const { db } = await import('../../db/database.js');
process.on('exit', () => {
  try { db.close(); } catch { /* process is already exiting */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${workDbPath}${suffix}`, { force: true }); } catch { /* temporary benchmark copy */ }
  }
});

type Query = { id: string; text: string };
type EvalData = { source: string; idPrefix: string; queries: Query[]; qrels: Record<string, Record<string, number>> };
type Keyword = { term: string; weight: number; synonyms: string[] };
const data = JSON.parse(fs.readFileSync(evalPath, 'utf8')) as EvalData;
const articles = loadArticlesFromDb();
const queries = data.queries.slice(0, queryLimit);
const allTermDfs = new Map<string, number>();
for (const article of articles) {
  const tokens = new Set((article.morphologicalTokens?.length ? article.morphologicalTokens : article.tokens ?? []).map(term => term.toLowerCase()));
  for (const token of tokens) allTermDfs.set(token, (allTermDfs.get(token) ?? 0) + 1);
}

const technicalPattern = /\b[A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9+#-]+)+|\d+(?:\.\d+)?(?:%|[A-Za-z]+|系|世代|番|型)/gu;
const synonymMap: Record<string, string[]> = {
  database: ['db'],
  error: ['failure'],
  lock: ['locking'],
  search: ['retrieval'],
  article: ['paper'],
};
const modes = ['A-current-six', 'B-all-terms', 'C-salience-idf', 'D-technical-preservation', 'E-limited-synonyms'] as const;
type ModeMetrics = { ndcg10: number[]; recall100: number[]; mrr10: number[]; elapsedMs: number[]; tokenPreparationMs: number[]; scoringMs: number[]; sortingLimitMs: number[] };
const scores: Record<(typeof modes)[number], ModeMetrics> = Object.fromEntries(modes.map(mode => [mode, { ndcg10: [], recall100: [], mrr10: [], elapsedMs: [], tokenPreparationMs: [], scoringMs: [], sortingLimitMs: [] }])) as never;

function keywordsFor(terms: string[], text: string, mode: (typeof modes)[number]): Keyword[] {
  const analyzed = analyzeQuery(text, terms, term => (/^[a-z0-9.+#-]+$/i.test(term) ? 1.5 : 1));
  let keywords = analyzed.keywords.map(keyword => ({ ...keyword, synonyms: [] as string[] }));
  if (mode === 'C-salience-idf' || mode === 'D-technical-preservation' || mode === 'E-limited-synonyms') {
    const idfs = keywords.map(({ term }) => Math.log((articles.length + 1) / ((allTermDfs.get(term.toLowerCase()) ?? 0) + 1)) + 1);
    const mean = idfs.reduce((sum, idf) => sum + idf, 0) / Math.max(idfs.length, 1);
    keywords = keywords.map((keyword, index) => ({
      ...keyword,
      weight: GENERIC_TERMS.has(keyword.term) ? 0.4 : Math.max(0.75, Math.min(2, idfs[index]! / mean)),
    }));
  }
  if (mode === 'E-limited-synonyms') {
    keywords = keywords.map(keyword => ({ ...keyword, synonyms: synonymMap[keyword.term.toLowerCase()] ?? [] }));
  }
  return keywords;
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

function queryMetrics(ranking: string[], judged: Record<string, number>) {
  const relevant = Object.entries(judged).filter(([, grade]) => grade > 0);
  const ideal = relevant.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, 10);
  const gradeAt = (id: string) => judged[id] ?? 0;
  const firstRelevant = ranking.findIndex(id => gradeAt(id) > 0);
  return {
    ndcg10: ideal.length ? dcg(ranking.slice(0, 10).map(gradeAt)) / dcg(ideal) : 0,
    recall100: relevant.length ? relevant.filter(([id]) => ranking.slice(0, 100).includes(id)).length / relevant.length : 0,
    mrr10: firstRelevant >= 0 && firstRelevant < 10 ? 1 / (firstRelevant + 1) : 0,
  };
}

const rawTerms = new Map<string, string[]>();
for (const query of queries) rawTerms.set(query.id, await purposeWords(query.text));
if (parseOnly) {
  const termCounts = [...rawTerms.values()].map(terms => terms.length);
  console.log(JSON.stringify({
    dataset: datasetName,
    queries: queries.length,
    moreThanSixTerms: termCounts.filter(count => count > 6).length,
    maximumTerms: Math.max(...termCounts, 0),
    examples: queries.map(query => ({ query: query.text, terms: rawTerms.get(query.id) })).filter(item => item.terms!.length > 6).slice(0, 10),
  }, null, 2));
  process.exit(0);
}
const baselineMemory = process.memoryUsage();
let peakMemory = baselineMemory;
const memorySampler = setInterval(() => {
  const current = process.memoryUsage();
  peakMemory = {
    ...peakMemory,
    rss: Math.max(peakMemory.rss, current.rss),
    heapUsed: Math.max(peakMemory.heapUsed, current.heapUsed),
  };
}, 25);
for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
  const query = queries[queryIndex]!;
  const wholeTerms = rawTerms.get(query.id)!;
  const naturalTerms = new Set(await tokenizeNouns(query.text.replace(technicalPattern, ' ')));
  for (const word of query.text.replace(technicalPattern, ' ').match(/[A-Za-z][A-Za-z0-9]{1,}/gu) ?? []) naturalTerms.add(word.toLowerCase());
  for (const mode of modes) {
    let terms = mode === 'A-current-six' ? wholeTerms.slice(0, 6)
      : mode === 'C-salience-idf' ? [...naturalTerms]
        : mode === 'D-technical-preservation' || mode === 'E-limited-synonyms'
          ? [...new Set([...naturalTerms, ...(query.text.match(technicalPattern) ?? []).map(word => word.toLowerCase())])]
          : wholeTerms;
    terms = [...new Set(terms)];
    const keywords = keywordsFor(terms, query.text, mode);
    const start = performance.now();
    const result = await runPipeline(articles, {
      label: mode,
      description: 'Query-analysis comparison with fixed BM25 ranking settings',
      k1: 1.2,
      b: 0.75,
      lambda: 0,
      contextBonus: 1.2,
      keywords,
    }, 'query-analysis-evaluation', { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 100 });
    const elapsedMs = performance.now() - start;
    const ranking = result.active
      .sort((a, b) => b.score - a.score)
      .map(item => item.article.id.startsWith(data.idPrefix) ? item.article.id.slice(data.idPrefix.length) : item.article.id)
      .slice(0, 100);
    const judged = data.qrels[query.id] ?? {};
    const metrics = queryMetrics(ranking, judged);
    scores[mode].ndcg10.push(metrics.ndcg10);
    scores[mode].recall100.push(metrics.recall100);
    scores[mode].mrr10.push(metrics.mrr10);
    scores[mode].elapsedMs.push(elapsedMs);
    scores[mode].tokenPreparationMs.push(result.stats.timings?.tokenPreparationMs ?? 0);
    scores[mode].scoringMs.push(result.stats.timings?.scoringMs ?? 0);
    scores[mode].sortingLimitMs.push(result.stats.timings?.sortingLimitMs ?? 0);
  }
  if ((queryIndex + 1) % 10 === 0) console.error(`evaluated ${queryIndex + 1}/${queries.length} queries`);
}
clearInterval(memorySampler);
const finalMemory = process.memoryUsage();
const maxObservedRss = Math.max(baselineMemory.rss, peakMemory.rss, finalMemory.rss);
const maxObservedHeapUsed = Math.max(baselineMemory.heapUsed, peakMemory.heapUsed, finalMemory.heapUsed);

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
const summary = Object.fromEntries(modes.map(mode => [mode, {
  queries: queries.length,
  ndcg10: Number(mean(scores[mode].ndcg10).toFixed(4)),
  recall100: Number(mean(scores[mode].recall100).toFixed(4)),
  mrr10: Number(mean(scores[mode].mrr10).toFixed(4)),
  searchP50Ms: Number(percentile(scores[mode].elapsedMs, 0.5).toFixed(2)),
  searchP95Ms: Number(percentile(scores[mode].elapsedMs, 0.95).toFixed(2)),
  tokenPreparationP50Ms: Number(percentile(scores[mode].tokenPreparationMs, 0.5).toFixed(2)),
  scoringP50Ms: Number(percentile(scores[mode].scoringMs, 0.5).toFixed(2)),
  sortingP50Ms: Number(percentile(scores[mode].sortingLimitMs, 0.5).toFixed(2)),
}]));
console.log(JSON.stringify({
  dataset: datasetName,
  documents: articles.length,
  evaluatedQueries: queries.length,
  labelSource: 'fixed public benchmark judgments; this run uses the isolated imported subset, not official leaderboard conditions',
  ranking: { algorithm: 'existing runPipeline', k1: 1.2, b: 0.75, lambda: 0, contextBonus: 1.2, dedupThreshold: 1 },
  memoryMiB: {
    baselineRss: Number((baselineMemory.rss / 1024 ** 2).toFixed(1)),
    maxObservedRss: Number((maxObservedRss / 1024 ** 2).toFixed(1)),
    maxObservedHeapUsed: Number((maxObservedHeapUsed / 1024 ** 2).toFixed(1)),
    finalRss: Number((finalMemory.rss / 1024 ** 2).toFixed(1)),
    finalHeapUsed: Number((finalMemory.heapUsed / 1024 ** 2).toFixed(1)),
    note: 'process-level observed high-water includes corpus, tokenizer and all evaluated variants; 25ms sampling may miss shorter transient peaks',
  },
  variants: summary,
}, null, 2));
