import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readRefindStudyEvents } from '../../routes/refind_study_routes.ts';

const root = process.cwd();
const [studyArg, finalArg, developmentArg] = process.argv.slice(2);
const studyDirectory = path.resolve(root, studyArg ?? 'quality/e2e/local/personal-refind/study');
const finalDirectory = path.resolve(root, finalArg ?? 'quality/e2e/local/personal-refind/final');
const developmentDirectories = developmentArg
  ? [path.resolve(root, developmentArg)]
  : [path.resolve(root, 'quality/e2e/local/personal-refind'), path.resolve(root, 'quality/e2e/local/personal-refind/development')];
const outputBase = path.resolve(finalDirectory, '..', 'capture-review');
const privateRoot = path.resolve(root, 'quality/e2e/local/personal-refind');
const isWithinPrivateRoot = directory => directory === privateRoot || directory.startsWith(`${privateRoot}${path.sep}`);
for (const directory of [studyDirectory, finalDirectory, ...developmentDirectories]) {
  if (!isWithinPrivateRoot(directory)) throw new Error('Capture, final, and development paths must stay inside the Git-ignored personal-refind directory.');
}

function readRecords(directories, prefix) {
  return directories.flatMap(directory => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && (!prefix || entry.name.startsWith(prefix)))
      .map(entry => JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
  });
}
function normalizeQuery(query) {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}
function safeName(value) { return value.replace(/[^A-Za-z0-9_-]/gu, '_'); }
function writeNew(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
function writeIdempotently(directory, name, value) {
  const file = path.join(directory, name);
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('An existing local export conflicts with the current capture journal; preserve both and review locally.');
    return false;
  }
  writeNew(directory, name, value);
  return true;
}

const events = readRefindStudyEvents(studyDirectory);
const journalPath = path.join(studyDirectory, 'events.jsonl');
if (events.length && !fs.existsSync(journalPath)) throw new Error('Capture journal is missing.');
const sessions = new Map(events.filter(event => event.kind === 'session').map(event => [event.sid, event]));
const responses = new Map();
const adjudications = new Map();
for (const event of events) {
  if (event.kind === 'interaction' && event.action === 'search_response' && !responses.has(event.sid)) responses.set(event.sid, event);
  if (event.kind === 'adjudication' && !adjudications.has(event.sid)) adjudications.set(event.sid, event);
}
const development = readRecords(developmentDirectories, 'personal-dev-');
const existingFinal = readRecords([finalDirectory], 'personal-final-');
const developmentTargets = new Set(development.flatMap(record => record.goldIds ?? []));
const captureRecordIds = new Set([...sessions.keys()].map(sid => `personal-final-${sid}`));
const queryHashes = new Set([...development, ...existingFinal.filter(record => !captureRecordIds.has(record.id))]
  .map(record => normalizeQuery(record.query)));
const totals = { sessions: sessions.size, pending: 0, primaryEligible: 0, ineligible: 0, nonPrimary: 0, exported: 0, surplus: 0 };
const eligibleRecords = [];
const ineligibleRecords = [];

for (const [sid, session] of sessions) {
  const adjudication = adjudications.get(sid);
  if (!adjudication) { totals.pending += 1; continue; }
  const category = adjudication.category;
  if (category !== 'memory') {
    if (typeof session.query === 'string') queryHashes.add(normalizeQuery(session.query));
    totals.nonPrimary += 1;
    continue;
  }
  const goldIds = Array.isArray(adjudication.gold_ids) ? [...new Set(adjudication.gold_ids)] : [];
  const lockedAt = Date.parse(session.at);
  const verifiedAt = Date.parse(adjudication.at);
  const savedBeforeQuery = goldIds.length > 0 && goldIds.every(id => {
    const createdAt = Date.parse(session.card_created_at_at_start?.[id] ?? '');
    return session.card_ids_at_start?.includes(id) && Number.isFinite(createdAt) && createdAt <= lockedAt;
  });
  const targetOverlap = goldIds.some(id => developmentTargets.has(id));
  const queryKey = normalizeQuery(session.query ?? '');
  const duplicateQuery = !queryKey || queryHashes.has(queryKey);
  const humanVerified = adjudication.reviewed_by_human === true && adjudication.status === 'verified' && goldIds.length > 0;
  const isEligible = session.source === 'human-typed-live-local-api' && session.consent_declared === true
    && humanVerified && savedBeforeQuery && !targetOverlap && !duplicateQuery
    && Number.isFinite(lockedAt) && Number.isFinite(verifiedAt) && verifiedAt >= lockedAt;
  const reason = isEligible ? '本人が自然な内容記憶検索と検索前から保存済みの正解を確認。対象・質問の分割重複なし。'
    : !humanVerified ? '正解ラベルが本人確認済みではない。'
      : !savedBeforeQuery ? '正解記事が検索開始前に保存されていたことを確認できない。'
        : targetOverlap ? '開発用の対象記事グループと重複。'
          : duplicateQuery ? '開発用または最終評価用の質問と重複。'
            : '収集時刻または記録元が適格条件を満たさない。';
  const response = responses.get(sid);
  const record = {
    id: `personal-final-${sid}`,
    query: session.query,
    queryLockedAt: session.at,
    origin: 'human-natural-refind',
    collectionChannel: 'in-app-local-explicit-consent',
    category: 'memory',
    split: 'final',
    targetGroupId: [...goldIds].sort().join('+'),
    goldIds: [...goldIds].sort(),
    humanVerified,
    savedBeforeQuery,
    verifiedAt: adjudication.at,
    eligibility: isEligible ? 'eligible' : 'ineligible',
    eligibilityReason: reason,
    observedSession: response ? {
      capturedAt: response.at,
      top10Ids: Array.isArray(response.top10) ? response.top10.slice(0, 10) : [],
      candidateIdsBeforeRerank: Array.isArray(response.candidate_ids_before_rerank) ? response.candidate_ids_before_rerank : null,
      httpStatus: response.http_status ?? null,
      error: response.error ?? null,
      timedOut: /timeout|timed out/i.test(response.error ?? ''),
      totalLatencyMs: Number.isFinite(response.latency_ms) ? response.latency_ms : null,
      actualEngine: response.actual_engine ?? null,
      fallbackUsed: response.fallback_used ?? null,
      applicationBuildId: session.build_id ?? null,
    } : {
      capturedAt: session.at, top10Ids: [], candidateIdsBeforeRerank: null,
      httpStatus: null, error: 'search-response-missing', timedOut: true,
      totalLatencyMs: null, actualEngine: null, fallbackUsed: null,
      applicationBuildId: session.build_id ?? null,
    },
    evaluationRun: null,
  };
  if (isEligible) {
    eligibleRecords.push(record);
  } else {
    ineligibleRecords.push(record);
    totals.ineligible += 1;
  }
  if (queryKey) queryHashes.add(queryKey);
}

const selectedFinal = eligibleRecords.slice(0, 100);
for (const record of selectedFinal) {
  const wrote = writeIdempotently(finalDirectory, `${safeName(record.id)}.json`, record);
  if (wrote) totals.exported += 1;
}
for (const record of ineligibleRecords) writeIdempotently(path.join(outputBase, 'ineligible'), `${safeName(record.id)}.json`, record);
for (const record of eligibleRecords.slice(100)) {
  if (writeIdempotently(path.join(outputBase, 'surplus'), `${safeName(record.id)}.json`, record)) totals.surplus += 1;
}
totals.primaryEligible = selectedFinal.length;

console.log(JSON.stringify({ status: 'EXPORTED', ...totals,
  finalDirectory: path.relative(root, finalDirectory), reviewDirectory: path.relative(root, outputBase),
  sourceJournalSha256: fs.existsSync(journalPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(journalPath)).digest('hex') : null }));
