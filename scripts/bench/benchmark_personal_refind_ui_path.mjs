import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { fingerprintSavedCardCorpus, fingerprintSavedCardFtsIndexes } from './personal_refind_freeze_io.mjs';

const [sourceArg, outputArg, roundsArg = '3'] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw Error('Usage: npx tsx scripts/bench/benchmark_personal_refind_ui_path.mjs <private-source.sqlite> <new-private-output-directory> [rounds]');
const rounds = Number(roundsArg);
if (!Number.isInteger(rounds) || rounds < 3 || rounds > 10) throw Error('Rounds must be an integer from 3 to 10');
const privateRoot = fs.realpathSync('quality/e2e/local/personal-refind');
function privatePath(arg, { mustExist = true } = {}) {
  const resolved = path.resolve(arg);
  const relative = path.relative(privateRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Source and output must be inside quality/e2e/local/personal-refind/');
  const parent = fs.realpathSync(path.dirname(resolved));
  const actualParent = path.relative(privateRoot, parent);
  if (actualParent.startsWith('..') || path.isAbsolute(actualParent)) throw Error('Path escapes the private directory through a link');
  if (mustExist) {
    const actual = fs.realpathSync(resolved);
    const actualRelative = path.relative(privateRoot, actual);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw Error('Path escapes the private directory through a link');
  }
  return resolved;
}
const sourcePath = privatePath(sourceArg);
const outputPath = privatePath(outputArg, { mustExist: false });
if (fs.existsSync(outputPath)) throw Error('Output directory already exists; observations are immutable');
const records = fs.readdirSync(privateRoot)
  .filter(name => /^personal-dev-\d+\.json$/u.test(name))
  .sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(privateRoot, name), 'utf8')))
  .filter(record => record.split === 'development' && typeof record.query === 'string' && record.query.trim()
    && record.queryLockedAt && Array.isArray(record.goldIds) && record.goldIds.length > 0);
if (!records.length) throw Error('No locked, human-confirmed development questions are available');
fs.mkdirSync(outputPath);
const snapshotPath = path.join(outputPath, 'corpus.sqlite');
const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
if (sourceDb.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Source corpus failed integrity_check');
const sourceContent = fingerprintSavedCardCorpus(sourceDb);
const sourceFts = fingerprintSavedCardFtsIndexes(sourceDb);
await sourceDb.backup(snapshotPath);
sourceDb.close();

const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
const snapshotContent = fingerprintSavedCardCorpus(snapshot);
const snapshotFts = fingerprintSavedCardFtsIndexes(snapshot);
if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok'
  || snapshotContent.sha256 !== sourceContent.sha256
  || JSON.stringify(snapshotFts) !== JSON.stringify(sourceFts)) throw Error('Isolated corpus copy failed integrity or fingerprint checks');
snapshot.close();

process.env.DB_PATH = snapshotPath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.CARD_SEARCH_ENGINE = 'fts5-morph';
delete process.env.API_KEY;
const [{ app }, { default: request }, { db }] = await Promise.all([
  import('../../app.ts'), import('supertest'), import('../../db/database.ts'),
]);
const fileSizeBytes = fs.statSync(snapshotPath).size;
const observations = [];
const roundsSummary = [];
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : 0;
};
const machine = {
  cpu: os.cpus()[0]?.model ?? null,
  ramBytes: os.totalmem(),
  node: process.version,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  powerScheme: (() => { try { return execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
};
try {
  const modes = await request(app).get('/api/modes');
  if (modes.status !== 200) throw Error('Could not load search modes');
  const firstStarted = performance.now();
  let firstRequestError = null;
  try {
    const parsed = await request(app).post('/api/search/terms').send({ text: records[0].query }).timeout({ deadline: 30_000 });
    if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw Error('Warm-up query analysis failed');
    const config = { label: 'saved-card-list-search', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1, keywords: parsed.body.keywords };
    const response = await request(app).post('/api/cards/search').send({ config,
      options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 500 },
      filters: { excludedTerms: [], sources: [], status: 'all' }, cardFilters: { archived: false },
    }).timeout({ deadline: 30_000 });
    if (response.status !== 200 || !Array.isArray(response.body?.active)) throw Error('Warm-up search failed');
  } catch (error) { firstRequestError = error.code ?? error.name ?? 'Error'; }
  const firstRequestMs = performance.now() - firstStarted;
  for (let round = 1; round <= rounds; round++) {
    const roundTimes = [];
    const roundErrors = [];
    for (const record of records) {
      const started = performance.now();
      let observation = { round, caseId: record.id, rank: null, hit10: false, actualEngine: null, httpStatus: null, error: null, timedOut: false, totalLatencyMs: null, searchApiMs: null };
      const deadline = () => Math.max(1, 30_000 - (performance.now() - started));
      try {
        const parsed = await request(app).post('/api/search/terms').send({ text: record.query }).timeout({ deadline: deadline() });
        observation.httpStatus = parsed.status;
        if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw Error('Query analysis failed');
        const config = { label: 'saved-card-list-search', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1,
          keywords: parsed.body.keywords };
        const searchStarted = performance.now();
        const response = await request(app).post('/api/cards/search').send({ config,
          options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 500 },
          filters: { excludedTerms: [], sources: [], status: 'all' },
          cardFilters: { archived: false },
        }).timeout({ deadline: deadline() });
        observation.searchApiMs = performance.now() - searchStarted;
        observation.httpStatus = response.status;
        if (response.status !== 200 || !Array.isArray(response.body?.active)) throw Error('Saved-card search failed');
        const top10 = response.body.active.slice(0, 10).map(item => item.article?.id).filter(Boolean);
        const rank = top10.findIndex(id => record.goldIds.includes(id));
        observation.rank = rank < 0 ? null : rank + 1;
        observation.hit10 = rank >= 0;
        observation.actualEngine = response.body.scope?.searchMethod ?? null;
      } catch (error) {
        observation.error = error.code ?? error.name ?? 'Error';
        observation.timedOut = Boolean(error.timeout);
      } finally {
        observation.totalLatencyMs = performance.now() - started;
      }
      observations.push(observation);
      roundTimes.push(observation.totalLatencyMs);
      if (observation.error) roundErrors.push(observation.error);
    }
    roundsSummary.push({ round, queries: roundTimes.length, errors: roundErrors.length,
      p50Ms: percentile(roundTimes, 0.5), p95Ms: percentile(roundTimes, 0.95), maxMs: Math.max(...roundTimes) });
  }
  const afterContent = fingerprintSavedCardCorpus(db);
  const contentPreserved = afterContent.sha256 === sourceContent.sha256;
  if (!contentPreserved) throw Error('Search changed card content in the isolated copy');
  const report = {
    status: 'DEVELOPMENT_PERFORMANCE_DIAGNOSTIC_NOT_FINAL_QUALITY_EVIDENCE',
    generatedAt: new Date().toISOString(),
    corpus: { source: path.relative(privateRoot, sourcePath), cards: sourceContent.count,
      contentSha256: sourceContent.sha256, ftsIndexes: sourceFts, snapshotBytes: fileSizeBytes, contentPreserved },
    queries: { lockedHumanConfirmedDevelopmentCount: records.length, lockedPendingExcludedCount: fs.readdirSync(privateRoot)
      .filter(name => /^personal-dev-\d+\.json$/u.test(name)).length - records.length,
      rounds, warmupQueries: 1, cachePolicy: 'no application search-result cache; sequential direct requests' },
    requestPath: 'POST /api/search/terms then POST /api/cards/search with the saved-card list filters',
    engine: 'fts5-morph',
    machine,
    rounds: roundsSummary,
    hit10: { successes: observations.filter(row => row.hit10).length, total: observations.length,
      note: 'Exploratory development questions only; not final quality evidence' },
    firstRequestMs,
    firstRequestError,
    processMemoryBytes: process.memoryUsage().rss,
    observations,
  };
  fs.writeFileSync(path.join(outputPath, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, cards: sourceContent.count, questions: records.length, rounds: roundsSummary,
    hit10: report.hit10, firstRequestMs: report.firstRequestMs, firstRequestError, snapshotBytes: fileSizeBytes, contentPreserved, output: outputPath }));
} finally {
  db.close();
}
