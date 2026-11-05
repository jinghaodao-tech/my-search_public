import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const [engine = 'fts5-morph', label = engine, countArg = '100', corpusArg = 'quality/e2e/local/personal-refind/scale-10000-v2'] = process.argv.slice(2);
const requestsPerRound = Number(countArg);
if (!Number.isInteger(requestsPerRound) || requestsPerRound < 20 || requestsPerRound > 1000) throw Error('Request count must be 20..1000');
if (!['default', 'like', 'fts5', 'fts5-raw', 'fts5-morph'].includes(engine) || !/^[a-z0-9-]+$/.test(label)) throw Error('Invalid engine or run label');
const privateRoot = fs.realpathSync('quality/e2e/local/personal-refind');
const directory = fs.realpathSync(path.resolve(corpusArg));
const relative = path.relative(privateRoot, directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Corpus must be inside the private personal-refind directory');
const output = path.join(directory, `${label}-result.json`);
if (fs.existsSync(output)) throw Error('Refusing to overwrite a result');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const queries = JSON.parse(fs.readFileSync(path.join(directory, 'diagnostic-queries.json'), 'utf8'));
if (!Number.isInteger(manifest.documents) || manifest.documents < 10000 || queries.length !== 20 || queries.some(q => q.origin !== 'public-development-diagnostic')) throw Error('Unexpected diagnostic corpus');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
process.env.DB_PATH = path.join(directory, 'corpus.sqlite');
process.env.NODE_ENV = 'test'; process.env.SITE_SYNC = 'off';
if (engine === 'default') delete process.env.CARD_SEARCH_ENGINE;
else process.env.CARD_SEARCH_ENGINE = engine;
delete process.env.API_KEY;
const [{ app }, { db }, { default: request }, repository] = await Promise.all([
  import('../../app.ts'), import('../../db/database.ts'), import('supertest'), import('../../repositories/cards_repository.ts'),
]);
if (repository.savedCardCount() !== manifest.documents) throw Error('Corpus size changed');
const ftsStatus = repository.savedCardTokenFtsStatus();
if (!ftsStatus.ready || ftsStatus.cards !== manifest.documents) throw Error('Prepared FTS indexes are not ready');
const modes = await request(app).get('/api/modes');
if (modes.status !== 200) throw Error('Mode lookup failed');
const mode = Object.values(modes.body)[0];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
let powerPlan = 'unavailable';
try {
  const output = execFileSync('powercfg', ['/getactivescheme'], { windowsHide: true }).toString('latin1');
  const guid = output.match(/([0-9a-f-]{36})/iu)?.[1]?.toLowerCase();
  const knownPlans = new Map([
    ['381b4222-f694-41f0-9685-ff5bb260df2e', 'Balanced'],
    ['8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', 'High performance'],
    ['a1841308-3541-4fab-bc81-f71556f20b4a', 'Power saver'],
    ['e9a42b02-d5df-448d-aa00-03f14749eb61', 'Ultimate performance'],
  ]);
  powerPlan = guid ? `${knownPlans.get(guid) ?? 'Unknown'} (${guid})` : 'unavailable';
} catch {}
const result = { status: 'RUNNING', purpose: 'PUBLIC_DEVELOPMENT_PERFORMANCE_DIAGNOSTIC_NOT_PERSONAL_GOAL_PASS',
  generatedAt: new Date().toISOString(), engine, corpus: manifest,
  queryFingerprint: hash(JSON.stringify(queries)), configuration: mode, sequential: true,
  requestCountPerRound: requestsPerRound, queryOrder: 'same 20 development questions cycled in fixed order',
  searchResultCache: 'not used by these API routes; requests include parsing on every iteration',
  environment: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalRamBytes: os.totalmem(),
    os: `${os.platform()} ${os.release()}`, node: process.version, powerPlan,
    dependencyLockSha256: hash(fs.readFileSync('package-lock.json')) },
  firstSearch: null, rounds: [], memorySampling: '100ms plus query boundaries; synchronous blocking can hide intermediate peaks' };
async function search(query) {
  const started = performance.now();
  const remaining = () => Math.max(1, 30000 - (performance.now() - started));
  let status = null;
  try {
    const parsed = await request(app).post('/api/search/terms').send({ text: query.query }).timeout({ deadline: remaining() });
    status = parsed.status;
    if (status !== 200 || !Array.isArray(parsed.body.keywords)) throw Error('ParserFailure');
    const response = await request(app).post('/api/cards/search').send({ config: { label: 'scale-diagnostic',
      description: mode.description ?? '', k1: mode.k1, b: mode.b, lambda: mode.lambda, contextBonus: mode.contextBonus,
      keywords: parsed.body.keywords }, options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 50 },
      filters: { excludedTerms: [], sources: [], status: 'all' } }).timeout({ deadline: remaining() });
    status = response.status;
    if (status !== 200 || !Array.isArray(response.body.active)) throw Error('SearchFailure');
    return { id: query.id, latencyMs: performance.now() - started, status, error: null,
      method: response.body.scope?.searchMethod, timings: response.body.stats?.timings,
      top10Hash: hash(JSON.stringify(response.body.active.slice(0, 10).map(item => item.article.id))) };
  } catch (error) { return { id: query.id, latencyMs: performance.now() - started, status, error: error.code ?? error.message }; }
}
let peakRssBytes = 0, peakHeapBytes = 0;
const sample = () => { const m = process.memoryUsage(); peakRssBytes = Math.max(peakRssBytes, m.rss); peakHeapBytes = Math.max(peakHeapBytes, m.heapUsed); };
const timer = setInterval(sample, 100);
const persist = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
try {
  result.firstSearch = await search(queries[0]); persist();
  for (const query of queries) await search(query);
  console.log(JSON.stringify({ phase: 'warmup-complete', engine, firstSearchMs: result.firstSearch.latencyMs }));
  for (let round = 1; round <= 3; round++) {
    const rows = []; peakRssBytes = 0; peakHeapBytes = 0; sample();
    for (let i = 0; i < requestsPerRound; i++) {
      rows.push(await search(queries[i % queries.length])); sample();
      if ((i + 1) % 20 === 0) console.log(JSON.stringify({ phase: 'measure', engine, round, completed: i + 1 }));
    }
    result.rounds.push({ round, p50Ms: percentile(rows.map(row => row.latencyMs), .5), p95Ms: percentile(rows.map(row => row.latencyMs), .95),
      errors: rows.filter(row => row.error || row.latencyMs >= 30000).length, peakRssBytes, peakHeapBytes, rows });
    persist();
  }
  result.status = 'DIAGNOSTIC_COMPLETE';
  result.latencyThresholdMet = result.rounds.every(round => round.p95Ms <= 500 && round.errors === 0);
  result.databaseBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + (fs.existsSync(process.env.DB_PATH + suffix) ? fs.statSync(process.env.DB_PATH + suffix).size : 0), 0);
  persist();
  console.log(JSON.stringify({ output, status: result.status, latencyThresholdMet: result.latencyThresholdMet,
    rounds: result.rounds.map(({ rows, ...summary }) => summary) }));
} finally { clearInterval(timer); db.close(); }
