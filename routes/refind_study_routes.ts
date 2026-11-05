import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

type CardRef = { id: string; title: string; createdAt: string };
type StudyOptions = {
  directory: string;
  root: string;
  getCards: () => CardRef[];
  getCard: (id: string) => CardRef | null;
  buildId?: () => string;
  now?: () => Date;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sourceFingerprint(root: string): string {
  const entries = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  const allowed = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json', '.yaml', '.yml', '.sql']);
  const excluded = ['quality/', 'node_modules/', 'dist/', 'data/', 'artifacts/', 'reports/', 'test-results/', 'playwright-report/'];
  const names = [...new Set(entries.toString('utf8').split('\0').filter(Boolean).map(name => name.replace(/\\/g, '/')))]
    .filter(name => !excluded.some(prefix => name.startsWith(prefix)) && allowed.has(path.extname(name)) && !name.includes('.env'))
    .filter(name => {
      try { return fs.lstatSync(path.join(root, name)).isFile(); } catch { return false; }
    }).sort();
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(root, name));
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(name).update(Buffer.from([0])).update(length).update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function appendRefindStudyEvent(directory: string, kind: string, fields: Record<string, unknown>) {
  const journal = path.join(directory, 'events.jsonl');
  const previous = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).at(-1) : undefined;
  const priorHash = previous ? JSON.parse(previous).hash as string : 'genesis';
  const event: Record<string, unknown> = { kind, at: new Date().toISOString(), ...fields, previous_hash: priorHash };
  event.hash = crypto.createHash('sha256').update(canonical(event), 'utf8').digest('hex');
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(journal, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  return event;
}

export function readRefindStudyEvents(directory: string): Array<Record<string, any>> {
  const file = path.join(directory, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  let previous = 'genesis';
  const events: Array<Record<string, any>> = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, any>;
    if (event.previous_hash !== previous) throw new Error('Study event chain is invalid');
    const { hash, ...withoutHash } = event;
    if (crypto.createHash('sha256').update(canonical(withoutHash), 'utf8').digest('hex') !== hash) throw new Error('Study event hash is invalid');
    previous = hash;
    events.push(event);
  }
  return events;
}

function removePersonalRefindExports(studyDirectory: string, sessionIds: string[]) {
  if (path.basename(studyDirectory) !== 'study' || path.basename(path.dirname(studyDirectory)) !== 'personal-refind') return;
  const personalRoot = path.dirname(studyDirectory);
  const outputDirectories = [
    path.join(personalRoot, 'final'),
    path.join(personalRoot, 'capture-review', 'ineligible'),
    path.join(personalRoot, 'capture-review', 'surplus'),
  ];
  for (const sid of sessionIds) {
    if (!/^[0-9a-f-]{36}$/iu.test(sid)) continue;
    const name = `personal-final-${sid}.json`;
    for (const directory of outputDirectories) fs.rmSync(path.join(directory, name), { force: true });
  }
}

function sessionIdsForDeletion(studyDirectory: string): string[] {
  const journal = path.join(studyDirectory, 'events.jsonl');
  if (!fs.existsSync(journal)) return [];
  const ids = new Set<string>();
  for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.kind === 'session' && typeof event.sid === 'string' && /^[0-9a-f-]{36}$/iu.test(event.sid)) ids.add(event.sid);
    } catch { /* deletion must remain available if a local journal is damaged */ }
  }
  return [...ids];
}

export function createRefindStudyRouter(options: StudyOptions) {
  const router = express.Router();
  let cachedBuildId: string | undefined;
  const buildId = () => cachedBuildId ??= options.buildId ? options.buildId() : sourceFingerprint(options.root);
  const protocolPath = () => path.join(options.directory, 'protocol.json');
  const protocol = () => fs.existsSync(protocolPath()) ? JSON.parse(fs.readFileSync(protocolPath(), 'utf8')) : null;
  const now = () => options.now?.() ?? new Date();
  const recordRetentionExpiry = (config: Record<string, any>, registryPath: string) => {
    const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { attempts: [] };
    if (!registry.attempts.some((attempt: Record<string, unknown>) => attempt.study_id === config.study_id)) {
      registry.attempts.push({ study_id: config.study_id, attempt: config.attempt, status: 'EXPIRED_BY_RETENTION', expired_utc: now().toISOString() });
    }
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  };
  const expireIfPastDue = () => {
    const config = protocol();
    const expiry = typeof config?.expires_utc === 'string' ? Date.parse(config.expires_utc) : Number.NaN;
    if (!Number.isFinite(expiry) || expiry > now().getTime()) return;
    const registryPath = path.join(options.directory, 'registry.json');
    removePersonalRefindExports(options.directory, sessionIdsForDeletion(options.directory));
    fs.rmSync(options.directory, { recursive: true, force: true });
    fs.mkdirSync(options.directory, { recursive: true });
    recordRetentionExpiry(config, registryPath);
  };
  const expireArchivedStudies = () => {
    const archiveRoot = path.join(options.root, 'quality', 'e2e', 'study_archive');
    if (!fs.existsSync(archiveRoot)) return;
    for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const archivedDirectory = path.join(archiveRoot, entry.name);
      const archivedProtocol = path.join(archivedDirectory, 'protocol.json');
      if (!fs.existsSync(archivedProtocol)) continue;
      const config = JSON.parse(fs.readFileSync(archivedProtocol, 'utf8'));
      const expiry = typeof config.expires_utc === 'string' ? Date.parse(config.expires_utc) : Number.NaN;
      if (!Number.isFinite(expiry) || expiry > now().getTime()) continue;
      fs.rmSync(archivedDirectory, { recursive: true, force: true });
      recordRetentionExpiry(config, path.join(options.directory, 'registry.json'));
    }
  };
  const expiredByRetention = () => {
    const registryPath = path.join(options.directory, 'registry.json');
    if (!fs.existsSync(registryPath)) return false;
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return registry.attempts.some((attempt: Record<string, unknown>) => attempt.status === 'EXPIRED_BY_RETENTION');
  };
  const enabledProtocol = () => {
    const value = protocol();
    if (!value || fs.existsSync(path.join(options.directory, 'seal.json'))) return null;
    if (value.build_id !== 'rolling-personal' && value.build_id !== buildId()) return null;
    return value;
  };
  const requireLocal = (req: express.Request, res: express.Response) => {
    if (isLoopbackAddress(req.socket.remoteAddress ?? '')) return true;
    res.status(403).json({ error: 'local_only' });
    return false;
  };

  router.get('/refind-study/status', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    const config = protocol();
    const currentBuildId = buildId();
    res.json({ available: Boolean(enabledProtocol()), preregistered: Boolean(config),
      buildMatches: config?.build_id === 'rolling-personal' || config?.build_id === currentBuildId,
      buildId: currentBuildId, scope: config?.scope ?? null, plannedN: config?.planned_n ?? null,
      targetPopulation: config?.target_population ?? null, retention: config?.retention ?? null,
      collected: readRefindStudyEvents(options.directory).filter(event => event.kind === 'session').length,
      sealed: fs.existsSync(path.join(options.directory, 'seal.json')), expiredByRetention: expiredByRetention() });
  });

  router.post('/refind-study/sessions', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    const config = enabledProtocol();
    if (!config) return res.status(409).json({ error: 'study_not_preregistered_for_this_build' });
    const { participant, query, consent } = req.body ?? {};
    if (consent !== true || typeof participant !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(participant)
      || typeof query !== 'string' || !query.trim() || query.length > 4000) return res.status(400).json({ error: 'invalid_study_session' });
    const events = readRefindStudyEvents(options.directory);
    const sessions = events.filter(event => event.kind === 'session');
    if (sessions.length >= config.planned_n) return res.status(409).json({ error: 'planned_sample_complete' });
    if (config.scope === 'multi-user' && sessions.some(event => event.participant === participant)) return res.status(409).json({ error: 'participant_already_recorded' });
    const sid = crypto.randomUUID();
    const cards = options.getCards();
    const cardSetHash = crypto.createHash('sha256').update(canonical(cards.map(card => card.id).sort()), 'utf8').digest('hex');
    const event = appendRefindStudyEvent(options.directory, 'session', {
      sid, study_id: config.study_id, participant, build_id: buildId(), query: query.trim(), top10: [],
      latency_ms: null, http_status: null, error: 'search_pending', source: 'human-typed-live-local-api', consent_declared: true,
      card_count: cards.length, card_set_sha256: cardSetHash, card_ids_at_start: cards.map(card => card.id).sort(),
      card_created_at_at_start: Object.fromEntries(cards.map(card => [card.id, card.createdAt])),
    });
    res.status(201).json({ sid, startedAt: event.at, cardCount: cards.length });
  });

  router.post('/refind-study/sessions/:sid/interactions', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    if (!enabledProtocol()) return res.status(409).json({ error: 'study_not_preregistered_for_this_build' });
    const events = readRefindStudyEvents(options.directory);
    const session = events.find(event => event.kind === 'session' && event.sid === req.params.sid);
    if (!session) return res.status(404).json({ error: 'study_session_not_found' });
    const { action } = req.body ?? {};
    if (action === 'search_response') {
      const top10 = req.body.top10;
      if (!Array.isArray(top10) || top10.length > 10
        || top10.some((id: unknown) => typeof id !== 'string' || !session.card_ids_at_start.includes(id))
        || new Set(top10).size !== top10.length) return res.status(400).json({ error: 'invalid_top10' });
      const candidates = req.body.candidateIdsBeforeRerank;
      if (candidates !== undefined && candidates !== null && (!Array.isArray(candidates) || candidates.length > 500
        || candidates.some((id: unknown) => typeof id !== 'string' || !session.card_ids_at_start.includes(id))
        || new Set(candidates).size !== candidates.length)) {
        return res.status(400).json({ error: 'invalid_candidate_ids' });
      }
      const httpStatus = req.body.httpStatus ?? null;
      if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return res.status(400).json({ error: 'invalid_http_status' });
      appendRefindStudyEvent(options.directory, 'interaction', { sid: req.params.sid, action, top10, http_status: httpStatus,
        candidate_ids_before_rerank: candidates ?? null,
        actual_engine: typeof req.body.actualEngine === 'string' ? req.body.actualEngine.slice(0, 100) : null,
        fallback_used: typeof req.body.fallbackUsed === 'boolean' ? req.body.fallbackUsed : null,
        error: typeof req.body.error === 'string' ? req.body.error.slice(0, 300) : null,
        latency_ms: Number.isFinite(req.body.latencyMs) ? Math.max(0, Math.round(req.body.latencyMs)) : null });
    } else if (action === 'query') {
      if (typeof req.body.query !== 'string' || !req.body.query.trim() || req.body.query.length > 4000) return res.status(400).json({ error: 'invalid_query' });
      appendRefindStudyEvent(options.directory, 'interaction', { sid: req.params.sid, action, query: req.body.query.trim() });
    } else if (action === 'opened') {
      const cardId = req.body.cardId;
      if (typeof cardId !== 'string' || !session.card_ids_at_start.includes(cardId)) return res.status(400).json({ error: 'card_not_in_starting_corpus' });
      appendRefindStudyEvent(options.directory, 'interaction', { sid: req.params.sid, action, card_id: cardId });
    } else return res.status(400).json({ error: 'invalid_interaction' });
    res.status(201).json({ ok: true });
  });

  router.post('/refind-study/sessions/:sid/adjudication', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    const config = enabledProtocol();
    if (!config) return res.status(409).json({ error: 'study_not_preregistered_for_this_build' });
    const events = readRefindStudyEvents(options.directory);
    const session = events.find(event => event.kind === 'session' && event.sid === req.params.sid);
    if (!session) return res.status(404).json({ error: 'study_session_not_found' });
    if (events.some(event => event.kind === 'adjudication' && event.sid === req.params.sid)) return res.status(409).json({ error: 'already_adjudicated' });
    const { goldId, unknown, humanChecked } = req.body ?? {};
    const category = req.body?.category ?? (goldId ? 'memory' : 'unresolved');
    const goldIds: unknown[] = Array.isArray(req.body?.goldIds) ? req.body.goldIds : goldId ? [goldId] : [];
    const targetCategory = category === 'memory' || category === 'exact-title';
    const noTargetCategory = category === 'no-saved-target' || category === 'unresolved';
    if ((!targetCategory && !noTargetCategory) || (targetCategory && (!goldIds.length || unknown || humanChecked !== true))
      || (noTargetCategory && (goldIds.length || unknown !== true || (category === 'no-saved-target' && humanChecked !== true)))) {
      return res.status(400).json({ error: 'human_target_or_category_required' });
    }
    if (goldIds.some(id => typeof id !== 'string' || !session.card_ids_at_start.includes(id))
      || new Set(goldIds).size !== goldIds.length) return res.status(400).json({ error: 'target_not_present_before_search' });
    const interactions = events.filter(event => event.kind === 'interaction' && event.sid === req.params.sid);
    const opened = interactions.find(event => event.action === 'opened' && goldIds.includes(event.card_id));
    const completed = interactions.filter(event => event.action === 'search_response');
    const elapsedSeconds = opened ? Math.max(0, (Date.parse(opened.at) - Date.parse(session.at)) / 1000) : null;
    appendRefindStudyEvent(options.directory, 'adjudication', { sid: req.params.sid, category, gold_ids: goldIds,
      gold_id: goldIds[0] ?? null, status: targetCategory || category === 'no-saved-target' ? 'verified' : 'unresolved',
      reviewed_by_human: Boolean(humanChecked),
      opened_card_id: opened?.card_id ?? null, elapsed_seconds: elapsedSeconds,
      query_count: 1 + interactions.filter(event => event.action === 'query').length,
      response_count: completed.length, human_declared: true });
    res.status(201).json({ ok: true, category, goldCount: goldIds.length });
  });

  router.post('/refind-study/sessions/:sid/expire', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    if (!enabledProtocol()) return res.status(409).json({ error: 'study_not_preregistered_for_this_build' });
    const events = readRefindStudyEvents(options.directory);
    const session = events.find(event => event.kind === 'session' && event.sid === req.params.sid);
    if (!session) return res.status(404).json({ error: 'study_session_not_found' });
    if (events.some(event => event.kind === 'adjudication' && event.sid === req.params.sid)) return res.json({ ok: true, alreadyFinal: true });
    const interactions = events.filter(event => event.kind === 'interaction' && event.sid === req.params.sid);
    appendRefindStudyEvent(options.directory, 'adjudication', { sid: req.params.sid, gold_id: null, status: 'unresolved',
      reviewed_by_human: false, opened_card_id: null, elapsed_seconds: null,
      query_count: 1 + interactions.filter(event => event.action === 'query').length,
      response_count: interactions.filter(event => event.action === 'search_response').length,
      human_declared: false, ended_by_timeout: true });
    res.status(201).json({ ok: true });
  });

  router.delete('/refind-study', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    // Withdrawal invalidates the cohort and erases queries while retaining alpha-spending history.
    let registry: { attempts: Array<Record<string, unknown>> } = { attempts: [] };
    const registryPath = path.join(options.directory, 'registry.json');
    if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const config = protocol();
    if (config && !registry.attempts.some(attempt => attempt.study_id === config.study_id)) {
      registry.attempts.push({ study_id: config.study_id, attempt: config.attempt,
        status: 'WITHDRAWN_INCOMPLETE', withdrawn_utc: new Date().toISOString() });
    }
    removePersonalRefindExports(options.directory, sessionIdsForDeletion(options.directory));
    fs.rmSync(options.directory, { recursive: true, force: true });
    if (registry.attempts.length) {
      fs.mkdirSync(options.directory, { recursive: true });
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    }
    res.json({ deleted: true, nextStep: 'Register a new frozen cohort before collecting again.' });
  });

  router.get('/refind-study/cards', (req, res) => {
    if (!requireLocal(req, res)) return;
    expireIfPastDue();
    expireArchivedStudies();
    if (!enabledProtocol()) return res.status(409).json({ error: 'study_not_preregistered_for_this_build' });
    res.json(options.getCards().map(({ id, title }) => ({ id, title })));
  });

  return router;
}
