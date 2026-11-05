import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { auditFreezePayload } from './personal_refind_freeze.mjs';
import { fingerprintSavedCardCorpus, fingerprintSavedCardFtsIndexes, readFreezeInputs, readManifestInputs,
  readPrivateManifest, resolvePrivatePath } from './personal_refind_freeze_io.mjs';
import { evaluateFrozenPersonalRefind } from './personal_refind_evaluator.mjs';
import { captureEffectiveSearchParameters, captureGitState, captureHostState, summarizeObservedSearchMethods } from './search_run_provenance.mjs';

const [manifestArg, outputArg] = process.argv.slice(2);
if (!manifestArg || !outputArg) throw Error('Usage: npx tsx scripts/bench/replay_frozen_personal_refind.mjs <private-freeze-manifest.json> <new-private-run-directory>');
const manifestPath = resolvePrivatePath(manifestArg);
const manifest = readPrivateManifest(manifestPath);
const inputs = readManifestInputs(manifest);
const initialAudit = auditFreezePayload(manifest, { ...inputs, minimumCases: manifest.minimumCases });
if (!initialAudit.valid) {
  console.log(JSON.stringify({ status: 'NOT_EVALUABLE', issues: initialAudit.issues }));
  process.exitCode = 2;
} else {
  const methods = new Set(['like', 'fts5', 'fts5-raw', 'fts5-morph', 'e5-rrf']);
  if (!methods.has(manifest.sources.method)) throw Error('Freeze method is not supported by the local card-search API');
  const configuration = JSON.parse(fs.readFileSync(path.join('quality/e2e/local/personal-refind', manifest.sources.configurationPath), 'utf8'));
  const settings = configuration.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Frozen configuration settings are invalid');
  const outputPath = resolvePrivatePath(outputArg, { mustExist: false });
  fs.mkdirSync(outputPath);
  const runId = crypto.randomUUID();
  const snapshotPath = path.join(outputPath, 'corpus.sqlite');
  const corpusPath = resolvePrivatePath(path.join('quality/e2e/local/personal-refind', manifest.sources.corpusPath));
  const sourceDb = new Database(corpusPath, { readonly: true, fileMustExist: true });
  try {
    if (sourceDb.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Frozen source corpus failed integrity_check');
    const sourceHash = fingerprintSavedCardCorpus(sourceDb);
    if (sourceHash.sha256 !== manifest.fingerprints.corpusSha256 || sourceHash.count !== manifest.fingerprints.corpusCount) {
      throw Error('Frozen source corpus no longer matches its manifest');
    }
    await sourceDb.backup(snapshotPath);
  } finally { sourceDb.close(); }

  const snapshot = new Database(snapshotPath, { fileMustExist: true });
  if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Evaluation snapshot failed integrity_check');
  const snapshotHash = fingerprintSavedCardCorpus(snapshot);
  if (snapshotHash.sha256 !== manifest.fingerprints.corpusSha256 || snapshotHash.count !== manifest.fingerprints.corpusCount) {
    snapshot.close();
    throw Error('Isolated snapshot does not match the frozen corpus');
  }
  const snapshotFts = fingerprintSavedCardFtsIndexes(snapshot);
  if (JSON.stringify(snapshotFts) !== JSON.stringify(manifest.fingerprints.ftsIndexes)) {
    snapshot.close();
    throw Error('Isolated snapshot indexes do not match the frozen manifest');
  }
  snapshot.close();

  process.env.DB_PATH = snapshotPath;
  process.env.NODE_ENV = 'test';
  process.env.SITE_SYNC = 'off';
  const pipelineEngine = settings.pipelineEngine ?? 'bm25';
  if (!['bm25', 'hybrid'].includes(pipelineEngine)) throw Error('Frozen pipelineEngine must be bm25 or hybrid');
  process.env.SEARCH_ENGINE = pipelineEngine;
  process.env.CARD_SEARCH_ENGINE = manifest.sources.method;
  const e5CandidateCount = settings.e5CandidateCount ?? 100;
  if (!Number.isInteger(e5CandidateCount) || e5CandidateCount < 20 || e5CandidateCount > 500) {
    throw Error('Frozen e5CandidateCount must be an integer from 20 through 500');
  }
  process.env.CARD_SEARCH_E5_CANDIDATES = String(e5CandidateCount);
  process.env.PERSONAL_REFIND_EVAL_CAPTURE = '1';
  if (manifest.sources.method === 'e5-rrf') {
    if (typeof configuration.model?.artifactPath !== 'string') throw Error('Frozen E5 evaluation requires a local model artifact path');
    if (configuration.model.id !== 'Xenova/multilingual-e5-small') throw Error('Frozen model ID does not match the E5 model used by this application');
    process.env.E5_MODEL_CACHE_DIR = path.resolve(configuration.model.artifactPath);
  }
  delete process.env.API_KEY;
  const [{ app }, { default: request }, { db }] = await Promise.all([
    import('../../app.ts'), import('supertest'), import('../../db/database.ts'),
  ]);
  const modesResponse = await request(app).get('/api/modes');
  if (modesResponse.status !== 200 || !modesResponse.body || typeof modesResponse.body !== 'object') throw Error('Could not load frozen search modes');
  const configuredMode = typeof settings.modeId === 'string' ? modesResponse.body[settings.modeId] : settings.mode;
  if (!configuredMode || typeof configuredMode !== 'object'
    || !['k1', 'b', 'lambda', 'contextBonus'].every(key => Number.isFinite(configuredMode[key]))) {
    throw Error('Frozen settings must identify a modeId or include exact k1, b, lambda and contextBonus values');
  }
  const options = settings.searchOptions ?? { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 500 };
  const filters = settings.filters ?? { excludedTerms: [], sources: [], status: 'all' };
  const effectiveSearchParameters = captureEffectiveSearchParameters({ method: manifest.sources.method, mode: configuredMode, modeId: settings.modeId ?? null,
    resultLimit: options.resultLimit, archiveScoreThreshold: options.archiveScoreThreshold, dedupThreshold: options.dedupThreshold,
    timeDecayFloor: options.timeDecayFloor, e5CandidateCount, pipelineEngine,
    bm25Weight: options.bm25Weight, ftsWeight: options.ftsWeight });
  const observations = [];
  try {
    for (const record of inputs.finalRecords) {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const observation = {
        runId,
        caseId: record.id,
        querySha256: crypto.createHash('sha256').update(record.query).digest('hex'),
        evaluationMode: 'frozen-isolated-replay',
        requestedEngine: manifest.sources.method,
        corpusSha256: manifest.fingerprints.corpusSha256,
        startedAt,
        actualEngine: null,
        fallbackUsed: null,
        candidateIdsBeforeRerank: null,
        top10Ids: [],
        httpStatus: null,
        error: null,
        timedOut: false,
        totalLatencyMs: null,
        searchTimings: null,
        contentPreserved: null,
      };
      const deadline = () => Math.max(1, 30000 - (performance.now() - started));
      try {
        const parsed = await request(app).post('/api/search/terms').send({ text: record.query }).timeout({ deadline: deadline() });
        observation.httpStatus = parsed.status;
        if (parsed.status !== 200 || !Array.isArray(parsed.body?.keywords)) throw Error('Query analysis failed');
        const config = { label: `frozen-${manifest.sources.method}`, description: configuredMode.description ?? '',
          k1: configuredMode.k1, b: configuredMode.b, lambda: configuredMode.lambda,
          contextBonus: configuredMode.contextBonus, keywords: parsed.body.keywords };
        const response = await request(app).post('/api/cards/search').send({ config, options, filters }).timeout({ deadline: deadline() });
        observation.httpStatus = response.status;
        if (response.status !== 200 || !Array.isArray(response.body?.active)) throw Error('Saved-card search failed');
        observation.top10Ids = response.body.active.slice(0, 10).map(item => item.article.id);
        observation.actualEngine = response.body.scope?.searchMethod ?? null;
        observation.fallbackUsed = response.body.scope?.fallbackUsed ?? false;
        observation.scoringMethods = [...new Set(response.body.active.map(item => item.scoreSources?.method).filter(value => typeof value === 'string'))].sort();
        observation.scoreSynthesis = response.body.active[0]?.scoreSources ?? null;
        observation.candidateIdsBeforeRerank = Array.isArray(response.body.scope?.candidateIdsBeforeRerank)
          ? response.body.scope.candidateIdsBeforeRerank : null;
        observation.searchTimings = response.body.stats?.timings ?? null;
      } catch (error) {
        observation.error = error.code ?? error.name ?? 'Error';
        observation.timedOut = Boolean(error.timeout);
      } finally {
        observation.totalLatencyMs = performance.now() - started;
      }
      observations.push(observation);
    }
    const contentPreserved = fingerprintSavedCardCorpus(db).sha256 === manifest.fingerprints.corpusSha256;
    for (const observation of observations) observation.contentPreserved = contentPreserved;
    if (!contentPreserved) throw Error('Evaluation snapshot content changed during search');
    const currentInputs = readFreezeInputs({
      recordsDirectory: path.join('quality/e2e/local/personal-refind', manifest.sources.recordsDirectory),
      developmentDirectory: path.join('quality/e2e/local/personal-refind', manifest.sources.developmentDirectory),
      corpusPath,
      configurationPath: path.join('quality/e2e/local/personal-refind', manifest.sources.configurationPath),
    });
    const finalAudit = auditFreezePayload(manifest, { ...currentInputs, minimumCases: manifest.minimumCases });
    const result = finalAudit.valid
      ? evaluateFrozenPersonalRefind(manifest, { ...currentInputs, minimumCases: manifest.minimumCases }, observations)
      : { status: 'NOT_EVALUABLE', issues: ['freeze-inputs-changed-during-run', ...finalAudit.issues] };
    const runProvenance = {
      createdAt: new Date().toISOString(),
      requestedMethod: manifest.sources.method,
      actualMethods: summarizeObservedSearchMethods(observations),
      effectiveSearchParameters,
      evaluationConditions: {
        workflow: 'frozen-isolated-replay',
        corpusSha256: manifest.fingerprints.corpusSha256,
        corpusCount: manifest.fingerprints.corpusCount,
        ftsIndexFingerprints: manifest.fingerprints.ftsIndexes,
        configurationSha256: manifest.fingerprints.configurationSha256,
        model: manifest.fingerprints.model,
        queryLimitMs: 30000,
        resultCache: 'not used by replay',
        settingsSha256: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
        filters: {
          status: filters.status ?? 'all',
          sourceCount: filters.sources?.length ?? 0,
          excludedTermCount: filters.excludedTerms?.length ?? 0,
          sinceConfigured: Boolean(filters.since),
          sha256: crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex'),
        },
      },
      gitStateAtRun: captureGitState(),
      hostStateAtRun: captureHostState(),
      gitStateAtFreeze: manifest.fingerprints.gitState ?? null,
      hostStateAtFreeze: manifest.fingerprints.hostState ?? null,
      privateQueryTextRecorded: false,
    };
    fs.writeFileSync(path.join(outputPath, 'observations.json'), JSON.stringify(observations, null, 2), { flag: 'wx' });
    fs.writeFileSync(path.join(outputPath, 'result.json'), JSON.stringify({ runId, frozenManifestSha256: manifest.manifestSha256, runProvenance, ...result }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, runId, questions: result.questions ?? observations.length,
      successes: result.successes ?? null, hit10: result.hit10 ?? null,
      candidateCoverage: result.candidateCoverage ?? null, actualEngines: result.actualEngines ?? null,
      fallbackCount: result.fallbackCount ?? null, output: outputPath }));
    if (result.status === 'NOT_EVALUABLE') process.exitCode = 2;
  } finally { db.close(); }
}
