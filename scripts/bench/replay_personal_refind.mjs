import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const [sourceArg, recordArg, outputArg, engine = 'like'] = process.argv.slice(2);
if (!sourceArg || !recordArg || !outputArg || !['like', 'fts5', 'fts5-raw', 'fts5-morph', 'e5-rrf'].includes(engine)) throw Error('Usage: npx tsx scripts/bench/replay_personal_refind.mjs <source.db> <development-record.json> <new-private-output-directory> [like|fts5|fts5-raw|fts5-morph|e5-rrf]');
const privateRoot = fs.realpathSync('quality/e2e/local');
function privatePath(arg) {
  const resolved = path.resolve(arg);
  const relative = path.relative(privateRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Records and output must be inside quality/e2e/local/');
  const parent = fs.realpathSync(path.dirname(resolved));
  const actual = path.relative(privateRoot, parent);
  if (actual.startsWith('..') || path.isAbsolute(actual)) throw Error('Private path escapes through a link');
  return resolved;
}
const recordPath = privatePath(recordArg);
const actualRecordPath = fs.realpathSync(recordPath);
const actualRecordRelative = path.relative(privateRoot, actualRecordPath);
if (!actualRecordRelative || actualRecordRelative.startsWith('..') || path.isAbsolute(actualRecordRelative)) throw Error('Record path escapes the private directory through a link');
const output = privatePath(outputArg);
if (fs.existsSync(output)) throw Error('Output must be a new directory; previous observations are immutable');
const record = JSON.parse(fs.readFileSync(actualRecordPath, 'utf8'));
if (record.split !== 'development' || typeof record.query !== 'string' || !record.query.trim() || !record.queryLockedAt) throw Error('Only locked development questions may be replayed with this exploratory tool');
fs.mkdirSync(output);
const snapshot = path.join(output, 'corpus.sqlite');
const source = new Database(path.resolve(sourceArg), { readonly: true, fileMustExist: true });
try { await source.backup(snapshot); } finally { source.close(); }
const copy = new Database(snapshot, { readonly: true, fileMustExist: true });
const contentQuery = 'SELECT id,title,body,summary,url,type,color,tags_json,links_json,kj_group_id,archived,archived_at,created_at,updated_at FROM cards ORDER BY id';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = copy.prepare(contentQuery).all();
const contentHash = hash(JSON.stringify(rows));
if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Invalid snapshot');
copy.close();
process.env.DB_PATH = snapshot;
process.env.NODE_ENV = 'test';
process.env.PERSONAL_REFIND_EVAL_CAPTURE = '1';
process.env.SITE_SYNC = 'off';
process.env.CARD_SEARCH_ENGINE = engine;
delete process.env.API_KEY;
const [{ app }, { default: request }, { db }] = await Promise.all([
  import('../../app.ts'), import('supertest'), import('../../db/database.ts'),
]);
const observation = { caseId: record.id, evaluationMode: 'isolated-development-replay', requestedEngine: engine, sourceRecordSha256: hash(fs.readFileSync(recordPath)),
  corpusContentSha256: contentHash, corpusCount: rows.length, startedAt: new Date().toISOString(),
  actualEngine: null, fallbackUsed: null, candidateIdsBeforeRerank: null, candidateHit: null,
  top10Ids: [], httpStatus: null, error: null, timedOut: false, totalLatencyMs: null };
try {
  const modes = await request(app).get('/api/modes');
  if (modes.status !== 200) throw Error('Could not load modes');
  const mode = Object.values(modes.body)[0];
  const start = performance.now();
  const deadline = () => Math.max(1, 30000 - (performance.now() - start));
  try {
    const parsed = await request(app).post('/api/search/terms').send({ text: record.query }).timeout({ deadline: deadline() });
    observation.httpStatus = parsed.status;
    if (parsed.status !== 200 || !Array.isArray(parsed.body.keywords)) throw Error('Parser failure');
    const config = { label: 'personal-development-replay', description: mode.description ?? '', k1: mode.k1, b: mode.b,
      lambda: mode.lambda, contextBonus: mode.contextBonus, keywords: parsed.body.keywords };
    const response = await request(app).post('/api/cards/search').send({ config,
      options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 50 },
      filters: { excludedTerms: [], sources: [], status: 'all' } }).timeout({ deadline: deadline() });
    observation.httpStatus = response.status;
    if (response.status !== 200 || !Array.isArray(response.body.active)) throw Error('Search failure');
    observation.top10Ids = response.body.active.slice(0, 10).map(item => item.article.id);
    observation.actualEngine = response.body.scope?.searchMethod ?? null;
    observation.fallbackUsed = response.body.scope?.fallbackUsed ?? false;
    observation.candidateIdsBeforeRerank = Array.isArray(response.body.scope?.candidateIdsBeforeRerank)
      ? response.body.scope.candidateIdsBeforeRerank : null;
    observation.candidateHit = Array.isArray(observation.candidateIdsBeforeRerank)
      ? observation.candidateIdsBeforeRerank.some(id => record.goldIds?.includes(id)) : null;
    observation.candidateCount = response.body.scope?.candidateCount ?? null;
    observation.e5CandidateCount = response.body.scope?.e5CandidateCount ?? null;
    observation.searchTimings = response.body.stats?.timings ?? null;
    fs.writeFileSync(path.join(output, 'configuration.json'), JSON.stringify(config, null, 2));
  } catch (error) {
    observation.error = error.code ?? error.name ?? 'Error';
    observation.timedOut = Boolean(error.timeout);
  } finally { observation.totalLatencyMs = performance.now() - start; }
  observation.contentPreserved = contentHash === hash(JSON.stringify(db.prepare(contentQuery).all()));
  if (!observation.contentPreserved) throw Error('Snapshot article or memo content changed');
  fs.writeFileSync(path.join(output, 'observation.json'), JSON.stringify(observation, null, 2), { flag: 'wx' });
  const rank = observation.top10Ids.findIndex(id => record.goldIds?.includes(id));
  console.log(JSON.stringify({ output, corpusCount: rows.length, rank: rank < 0 ? null : rank + 1,
    error: observation.error, totalLatencyMs: observation.totalLatencyMs, contentPreserved: observation.contentPreserved,
    status: 'DEVELOPMENT_ONLY_NOT_FINAL_EVIDENCE' }));
  if (observation.error) process.exitCode = 1;
} finally { db.close(); }
