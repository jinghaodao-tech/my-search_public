import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const [sourceArg = 'quality/e2e/local/personal-refind/scale-10000-v2/corpus.sqlite', label = 'run'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(label)) throw Error('Invalid run label');
const privateRoot = fs.realpathSync('quality/e2e/local/personal-refind');
const sourcePath = fs.realpathSync(path.resolve(sourceArg));
const relative = path.relative(privateRoot, sourcePath);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Source corpus must be inside the private personal-refind directory');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(sourcePath), 'manifest.json'), 'utf8'));
if (!Number.isInteger(sourceManifest.documents) || sourceManifest.documents < 10000 || !Number.isInteger(sourceManifest.personalDocuments)
  || typeof sourceManifest.corpusSha256 !== 'string') throw Error('Unexpected prepared 10,000-card corpus manifest');
const outputDirectory = path.join(privateRoot, `update-reflection-${label}`);
if (fs.existsSync(outputDirectory)) throw Error('Refusing to overwrite an existing private measurement');
fs.mkdirSync(outputDirectory);
const copyPath = path.join(outputDirectory, 'corpus.sqlite');
const outputPath = path.join(outputDirectory, 'result.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const targetFields = ['id','title','body','summary','url','type','color','tags_json','links_json','kj_group_id','archived',
  'archived_at','tokens_json','doc_length','morphological_tokens_json','ngram_tokens_json','morphological_doc_length',
  'ngram_doc_length','created_at','updated_at'];
const selectTargetFields = `SELECT ${targetFields.join(',')} FROM cards ORDER BY id`;
function corpusFingerprint(database) {
  const hash = crypto.createHash('sha256');
  let documents = 0;
  for (const row of database.prepare(selectTargetFields).iterate()) { hash.update(JSON.stringify(row)).update('\n'); documents += 1; }
  return { documents, sha256: hash.digest('hex') };
}
const personalDb = new Database('data/cards.db', { readonly: true, fileMustExist: true });
const personalRows = personalDb.prepare(selectTargetFields).all();
if (sourceManifest.personalDocuments !== personalRows.length) throw Error('Prepared corpus personal-card count differs from the current source DB');
const personalIds = new Set(personalRows.map(row => row.id));
const personalContentHash = sha256(JSON.stringify(personalRows));
const backupSource = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  if (backupSource.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Source corpus integrity check failed');
  const sourceFingerprint = corpusFingerprint(backupSource);
  if (sourceFingerprint.documents !== sourceManifest.documents || sourceFingerprint.sha256 !== sourceManifest.corpusSha256) {
    throw Error('Source corpus does not match its prepared manifest');
  }
  await backupSource.backup(copyPath);
} finally { backupSource.close(); }
const copiedCheck = new Database(copyPath, { readonly: true, fileMustExist: true });
try {
  const copiedFingerprint = corpusFingerprint(copiedCheck);
  if (copiedCheck.pragma('integrity_check', { simple: true }) !== 'ok' || copiedFingerprint.documents !== sourceManifest.documents
    || copiedFingerprint.sha256 !== sourceManifest.corpusSha256) throw Error('Isolated copy differs from the prepared source corpus');
} finally { copiedCheck.close(); }

process.env.DB_PATH = copyPath;
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
process.env.CARD_SEARCH_ENGINE = 'fts5-morph';
delete process.env.API_KEY;
const [{ app }, { db }, { default: request }, repository] = await Promise.all([
  import('../../app.ts'), import('../../db/database.ts'), import('supertest'), import('../../repositories/cards_repository.ts'),
]);
const count = repository.savedCardCount();
if (count < 10000) throw Error(`Expected at least 10,000 saved cards, got ${count}`);
const indexStatus = repository.savedCardTokenFtsStatus();
if (!indexStatus.ready || indexStatus.cards !== count) throw Error('Prepared FTS indexes are incomplete');
const sourceQueries = await request(app).get('/api/modes');
if (sourceQueries.status !== 200) throw Error('Search mode lookup failed');
const mode = Object.values(sourceQueries.body)[0];
const candidate = db.prepare("SELECT id FROM cards WHERE archived = 0 AND length(COALESCE(body, '')) <= 19000 ORDER BY id").all()
  .find(row => !personalIds.has(row.id));
if (!candidate) throw Error('No public supplemental card is available for the update probe');

const originalResponse = await request(app).get(`/api/cards/${encodeURIComponent(candidate.id)}`);
if (originalResponse.status !== 200 || typeof originalResponse.body.body !== 'string') throw Error('Could not read isolated probe card');
const originalBody = originalResponse.body.body;
const probeToken = `mysearchupdateprobe${crypto.randomBytes(8).toString('hex')}`;
const queryHash = sha256(probeToken);

async function searchProbe() {
  const started = performance.now();
  const parsed = await request(app).post('/api/search/terms').send({ text: probeToken }).timeout({ deadline: 30000 });
  if (parsed.status !== 200 || !Array.isArray(parsed.body.keywords) || !parsed.body.keywords.length) throw Error('Probe query analysis failed');
  const response = await request(app).post('/api/cards/search').send({
    config: { label: 'isolated-update-reflection', description: mode.description ?? '', k1: mode.k1, b: mode.b,
      lambda: mode.lambda, contextBonus: mode.contextBonus, keywords: parsed.body.keywords },
    options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 50 },
    filters: { excludedTerms: [], sources: [], status: 'all' }, cardFilters: { archived: false },
  }).timeout({ deadline: Math.max(1, 30000 - (performance.now() - started)) });
  if (response.status !== 200 || !Array.isArray(response.body.active)) throw Error('Probe search failed');
  const ordered = [...response.body.active, ...(response.body.belowThreshold ?? [])];
  const rank = ordered.findIndex(item => item.article?.id === candidate.id);
  return { elapsedMs: performance.now() - started, visible: rank >= 0, rank: rank >= 0 ? rank + 1 : null,
    engine: response.body.scope?.searchMethod ?? null, httpStatus: response.status };
}

async function waitForVisibility(expected, maxMs = 30000) {
  const started = performance.now();
  let last = null;
  while (performance.now() - started <= maxMs) {
    last = await searchProbe();
    if (last.visible === expected) return { status: 'OBSERVED', elapsedMs: performance.now() - started,
      firstObservedRank: expected ? last.rank : null, lastRequestEngine: last.engine };
    await delay(100);
  }
  return { status: 'TIMEOUT', elapsedMs: performance.now() - started, firstObservedRank: null, lastRequestEngine: last?.engine ?? null };
}

const originalPersonalHashInCopy = sha256(JSON.stringify(db.prepare(selectTargetFields).all().filter(row => personalIds.has(row.id))));
if (originalPersonalHashInCopy !== personalContentHash) throw Error('Personal card fields differ between the source and isolated corpus');
const before = await searchProbe();
if (before.visible) throw Error('Unique probe token unexpectedly matched before the update');

const result = {
  status: 'RUNNING', purpose: 'ISOLATED_UPDATE_REFLECTION_DIAGNOSTIC_NOT_PERSONAL_QUALITY_EVIDENCE',
  generatedAt: new Date().toISOString(), sourceCorpusSha256: sourceManifest.corpusSha256,
  sourceDocuments: sourceManifest.documents, querySha256: queryHash, engineRequested: 'fts5-morph', preparedSavedCards: count,
  measurementScriptSha256: sha256(fs.readFileSync(new URL(import.meta.url))),
  dependencyLockSha256: sha256(fs.readFileSync('package-lock.json')),
  targetClass: 'public supplemental card; target id and contents omitted', pollIntervalMs: 100,
  baseline: { visible: before.visible, httpStatus: before.httpStatus },
  personalContentPreservedBefore: true, updateReflection: null, restoreReflection: null,
  restored: false, personalContentPreservedAfter: false, sqliteIntegrityAfterRestore: null,
  environment: { cpu: os.cpus()[0]?.model, totalRamBytes: os.totalmem(), os: `${os.platform()} ${os.release()}`, node: process.version },
};
let updateApplied = false;
let measurementError = null;
try {
  const update = await request(app).put(`/api/cards/${encodeURIComponent(candidate.id)}`).send({ body: `${originalBody}\n${probeToken}` }).timeout({ deadline: 30000 });
  if (update.status !== 200) throw Error(`Isolated card update failed with HTTP ${update.status}`);
  updateApplied = true;
  result.updateReflection = await waitForVisibility(true);
} catch (error) {
  measurementError = error.message;
} finally {
  if (updateApplied) {
    try {
      const restore = await request(app).put(`/api/cards/${encodeURIComponent(candidate.id)}`).send({ body: originalBody }).timeout({ deadline: 30000 });
      if (restore.status === 200 && restore.body.body === originalBody) {
        result.restored = true;
        result.restoreReflection = await waitForVisibility(false);
      }
    } catch (error) { result.restoreError = error.message; }
  } else result.restored = true;
  result.personalContentPreservedAfter = sha256(JSON.stringify(db.prepare(selectTargetFields).all().filter(row => personalIds.has(row.id)))) === personalContentHash;
  result.sqliteIntegrityAfterRestore = db.pragma('integrity_check', { simple: true });
  result.measurementError = measurementError;
  result.status = result.updateReflection?.status === 'OBSERVED' && result.restored
    && result.restoreReflection?.status === 'OBSERVED' && result.personalContentPreservedAfter
    && result.sqliteIntegrityAfterRestore === 'ok' ? 'MEASURED' : 'INCOMPLETE';
  result.isolatedDatabaseBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + (fs.existsSync(copyPath + suffix) ? fs.statSync(copyPath + suffix).size : 0), 0);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  personalDb.close();
  db.close();
}
console.log(JSON.stringify({ output: outputPath, status: result.status, updateReflection: result.updateReflection,
  restoreReflection: result.restoreReflection, restored: result.restored, personalContentPreservedAfter: result.personalContentPreservedAfter,
  sqliteIntegrityAfterRestore: result.sqliteIntegrityAfterRestore, isolatedDatabaseBytes: result.isolatedDatabaseBytes }));
if (result.status !== 'MEASURED') process.exitCode = 2;
