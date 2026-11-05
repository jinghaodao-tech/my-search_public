import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const datasetName = process.argv[2] ?? 'miracl-ja';
const queryId = process.argv[3] ?? '191';
const prefix = datasetName === 'miracl-ja' ? 'miracl-ja-' : 'scifact-';
const dataPath = path.join(root, 'data', 'bench', `${datasetName}.eval.json`);
const dbPath = path.join(root, 'data', 'bench', `${datasetName}.db`);
const evalData = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as {
  idPrefix: string;
  queries: Array<{ id: string; text: string }>;
};
const query = evalData.queries.find(item => item.id === queryId);
if (!query) throw new Error(`Unknown query id: ${queryId}`);
const workDbPath = path.join(root, 'data', 'bench', 'work', `context-parity-${process.pid}.db`);
fs.mkdirSync(path.dirname(workDbPath), { recursive: true });
const { default: Database } = await import('better-sqlite3');
const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
await sourceDb.backup(workDbPath);
sourceDb.close();
process.env.DB_PATH = workDbPath;
const [{ db }, { loadArticlesFromDb }, { discoverMode, purposeWords }, { analyzeQuery }, { runPipeline }] = await Promise.all([
  import('../../db/database.js'),
  import('../../repositories/articles_repository.js'),
  import('../../services/discover_service.js'),
  import('../../services/query_analysis.js'),
  import('../../search/bm25.js'),
]);
try {
  const articles = loadArticlesFromDb();
  const terms = await purposeWords(query.text);
  const mode = discoverMode([], terms);
  const analyzed = analyzeQuery(query.text, terms, term => /[a-z0-9]/i.test(term) ? 3 : 2);
  mode.keywords = analyzed.keywords.map(keyword => ({ ...keyword, synonyms: [] }));
  const result = await runPipeline(articles, mode, 'bm25-ablation-reference', {
    archiveScoreThreshold: -1,
    dedupThreshold: 1,
    resultLimit: 100,
    timeDecayFloor: 0.5,
  });
  const artifactPath = path.join(root, 'artifacts', `bm25-ablation-${datasetName}-2026-10-20.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
    perQuery: Record<string, Array<{ queryId: string; top10: Array<{ id: string; score: number }> }>>;
  };
  const baseline = artifact.perQuery['A0-current-custom']!.find(row => row.queryId === queryId)!.top10;
  const production = result.active.slice(0, 10).map(row => ({ id: row.article.id.slice(evalData.idPrefix.length), score: row.score, breakdown: row.breakdown }));
  console.log(JSON.stringify({
    dataset: datasetName, queryId, query: query.text, keywords: mode.keywords,
    exactOrderMatch: baseline.every((row, index) => row.id === production[index]?.id),
    baseline,
    production,
    sameSet: baseline.every(row => production.some(item => item.id === row.id)),
  }, null, 2));
} finally {
  try { db.close(); } catch { /* close on exit */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${workDbPath}${suffix}`, { force: true }); } catch { /* isolated copy */ }
  }
}
