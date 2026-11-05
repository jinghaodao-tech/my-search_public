import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { isLoopbackAddress } from './refind_study_routes.js';

const phases = ['search', 'read', 'note', 'compare', 'save', 'refind', 'resume'] as const;
const syntheticTaskExperiments: Record<string, 'E0' | 'E6'> = {
  'synthetic-refind-01': 'E0', 'synthetic-resume-01': 'E0', 'synthetic-integrate-01': 'E6',
};
const workflowDefinitionIds = {
  E0: 'e0-synthetic-workflow-v1',
  E6: {
    mvp: 'e6-mvp-flat-baseline-v1',
    separated: 'e6-separated-manual-reentry-v2',
    integrated: 'e6-integrated-auto-share-v2',
  },
} as const;
const activityKinds = ['management', 'verification', 'correction'] as const;
const operations = ['navigate', 'select_result', 'copy_context', 'manual_reentry', 'save', 'retry', 'undo', 'dismiss_suggestion'] as const;
const eventKinds = ['phase_start', 'phase_end', 'activity_start', 'activity_end', 'management_operation', 'task_complete', 'task_abandon', 'error', 'suggestion_accept', 'suggestion_dismiss', 'cancel', 'undo'] as const;
const errorCategories = ['api_validation', 'state_transition', 'network', 'task_failure', 'other'] as const;
const conditionSchema = z.object({
  automation: z.enum(['manual', 'suggest', 'confirm', 'reversible_execute']).default('manual'),
  visibility: z.enum(['current', 'subtle_hint', 'nonmodal_expand']).default('current'),
  timing: z.enum(['on_request', 'task_boundary', 'immediate']).default('on_request'),
  workflow: z.enum(['mvp', 'separated', 'integrated']).default('mvp'),
}).strict().default({ automation: 'manual', visibility: 'current', timing: 'on_request', workflow: 'mvp' });
const startSchema = z.object({
  consent: z.literal(true),
  experiment: z.enum(['E0', 'E6']),
  taskId: z.string().regex(/^synthetic-[a-z0-9-]{1,40}$/),
  presentationId: z.enum(['synthetic-form-a', 'synthetic-form-b', 'synthetic-form-c']).default('synthetic-form-a'),
  condition: conditionSchema,
}).strict();
const eventSchema = z.object({
  event: z.enum(eventKinds),
  phase: z.enum(phases).optional(),
  category: z.enum(activityKinds).optional(),
  operation: z.enum(operations).optional(),
  error_category: z.enum(errorCategories).optional(),
  abandon_reason: z.enum(['participant_choice', 'time_limit', 'technical_issue']).optional(),
  outcome: z.enum(['success', 'failure', 'unknown']).optional(),
}).strict().superRefine((value, context) => {
  const requiredByEvent: Partial<Record<(typeof eventKinds)[number], string>> = {
    phase_start: 'phase', phase_end: 'phase', activity_start: 'category', activity_end: 'category',
    management_operation: 'operation', task_complete: 'outcome', task_abandon: 'abandon_reason', error: 'error_category',
  };
  const fieldForEvent = requiredByEvent[value.event];
  if (fieldForEvent && value[fieldForEvent as keyof typeof value] === undefined) context.addIssue({ code: 'custom', path: [fieldForEvent], message: `${fieldForEvent} is required` });
  const allowedByEvent: Record<string, string[]> = {
    phase_start: ['event', 'phase'], phase_end: ['event', 'phase'], activity_start: ['event', 'category'], activity_end: ['event', 'category'],
    management_operation: ['event', 'operation'], task_complete: ['event', 'outcome'], task_abandon: ['event', 'abandon_reason'], error: ['event', 'error_category'],
    suggestion_accept: ['event'], suggestion_dismiss: ['event'], cancel: ['event'], undo: ['event'],
  };
  for (const key of Object.keys(value)) if (!allowedByEvent[value.event].includes(key)) context.addIssue({ code: 'custom', path: [key], message: `${key} is not valid for ${value.event}` });
  if ((value.event === 'phase_start' || value.event === 'phase_end') && !value.phase) {
    context.addIssue({ code: 'custom', path: ['phase'], message: 'phase is required for phase events' });
  }
  if (value.event === 'task_complete' && !value.outcome) {
    context.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome is required for task completion' });
  }
  if ((value.event === 'activity_start' || value.event === 'activity_end') && !value.category) context.addIssue({ code: 'custom', path: ['category'], message: 'category is required' });
  if (value.event === 'management_operation' && !value.operation) context.addIssue({ code: 'custom', path: ['operation'], message: 'operation is required' });
  if (value.event === 'error' && !value.error_category) context.addIssue({ code: 'custom', path: ['error_category'], message: 'error_category is required' });
  if (value.event === 'task_abandon' && !value.abandon_reason) context.addIssue({ code: 'custom', path: ['abandon_reason'], message: 'abandon_reason is required' });
});

type EventRecord = Record<string, unknown> & { sid: string; kind: string; at?: string; elapsed_total_ms?: number; previous_hash?: string; hash?: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function sealEvents(records: EventRecord[]): string {
  let previous = 'genesis';
  const lines = records.map(record => {
    const { hash: _hash, previous_hash: _previousHash, ...payload } = record;
    const event = { ...payload, previous_hash: previous };
    const hash = crypto.createHash('sha256').update(canonical(event)).digest('hex');
    previous = hash;
    return JSON.stringify({ ...event, hash });
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}
function readEvents(file: string): EventRecord[] {
  if (!fs.existsSync(file)) return [];
  const events: EventRecord[] = [];
  let previous = 'genesis';
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as EventRecord;
    if (event.previous_hash !== previous) throw new Error('Research experiment journal chain is invalid');
    const { hash, ...withoutHash } = event;
    if (crypto.createHash('sha256').update(canonical(withoutHash)).digest('hex') !== hash) throw new Error('Research experiment journal hash is invalid');
    previous = hash!;
    events.push(event);
  }
  return events;
}
function rewriteEvents(file: string, directory: string, events: EventRecord[]) {
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.events-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, sealEvents(events), 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function createResearchExperimentRouter(options: { directory: string; now?: () => Date; retentionDays?: number; startRetentionTimer?: boolean }) {
  const router = express.Router();
  const file = path.join(options.directory, 'events.jsonl');
  const now = () => options.now?.() ?? new Date();
  const sessionStartedAt = new Map<string, number>();
  const activePhase = new Map<string, { name: string; startedAt: number }>();
  const activeActivity = new Map<string, { name: string; startedAt: number }>();
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error('retentionDays must be an integer from 1 to 365');
  const pruneExpired = () => {
    const events = readEvents(file);
    const sessions = events.filter(event => event.kind === 'session');
    const today = now().toISOString().slice(0, 10);
    const expired = new Set(sessions.filter(event => typeof event.expires_day === 'string' && event.expires_day <= today).map(event => event.sid));
    if (!expired.size) return;
    rewriteEvents(file, options.directory, events.filter(event => !expired.has(event.sid)));
    for (const sid of expired) { sessionStartedAt.delete(sid); activePhase.delete(sid); activeActivity.delete(sid); }
  };
  const requireLocal = (req: express.Request, res: express.Response) => {
    if (isTrustedLocalRequest({ remoteAddress: req.socket.remoteAddress ?? '', localAddress: req.socket.localAddress ?? '', host: req.header('host') ?? '', origin: req.header('origin') })) return true;
    res.status(403).json({ error: 'local_only' });
    return false;
  };
  const append = (record: EventRecord) => {
    const events = readEvents(file);
    fs.mkdirSync(options.directory, { recursive: true });
    const line = sealEvents([...events, record]).split('\n').filter(Boolean).at(-1);
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  };

  pruneExpired();
  if (options.startRetentionTimer) {
    const timer = setInterval(() => { try { pruneExpired(); } catch { /* corrupted logs stay in place and API requests report the error */ } }, 60 * 60 * 1000);
    timer.unref();
  }

  router.get('/research-experiments/status', (req, res) => {
    if (!requireLocal(req, res)) return;
    pruneExpired();
    const events = readEvents(file);
    const withdrawn = new Set(events.filter(event => event.kind === 'withdrawal').map(event => event.sid));
    res.json({ enabled: true, localOnly: true, consentRequired: true,
      sessions: new Set(events.filter(event => event.kind === 'session' && !withdrawn.has(event.sid)).map(event => event.sid)).size,
      workflowDefinitions: workflowDefinitionIds,
      collectedFields: ['random_session_id', 'experiment', 'synthetic_task_id', 'A/V/T/workflow_condition', 'workflow_definition_id', 'event_kind', 'phase', 'relative_time_ms', 'categorical_outcome'],
      excludedFields: ['article_content', 'query', 'url', 'memo', 'card_id', 'personal_identifier', 'absolute_timestamp'] });
  });

  router.post('/research-experiments/sessions', (req, res) => {
    if (!requireLocal(req, res)) return;
    pruneExpired();
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_session', issues: parsed.error.issues });
    const expectedExperiment = syntheticTaskExperiments[parsed.data.taskId];
    if (!expectedExperiment || parsed.data.experiment !== expectedExperiment) return res.status(400).json({ error: 'task_experiment_mismatch' });
    const sid = crypto.randomUUID();
    const startedAt = now();
    sessionStartedAt.set(sid, startedAt.getTime());
    const expiresAt = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate() + retentionDays));
    const workflow = parsed.data.experiment === 'E6'
      ? workflowDefinitionIds.E6[parsed.data.condition.workflow]
      : workflowDefinitionIds.E0;
    append({ kind: 'session', sid, consent: true, created_day: startedAt.toISOString().slice(0, 10), expires_day: expiresAt.toISOString().slice(0, 10), experiment: parsed.data.experiment,
      task_id: parsed.data.taskId, presentation_id: parsed.data.presentationId, condition: parsed.data.condition, workflow_definition_id: workflow });
    res.status(201).json({ sid, started: true, workflowDefinitionId: workflow });
  });

  router.post('/research-experiments/sessions/:sid/events', (req, res) => {
    if (!requireLocal(req, res)) return;
    pruneExpired();
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      const sid = req.params.sid;
      const events = readEvents(file);
      const hasOpenSession = events.some(event => event.kind === 'session' && event.sid === sid)
        && !events.some(event => event.sid === sid && event.kind === 'event' && ['task_complete', 'task_abandon', 'cancel'].includes(String(event.event)));
      const startedAt = sessionStartedAt.get(sid);
      if (hasOpenSession && startedAt !== undefined) append({ kind: 'event', sid, elapsed_total_ms: Math.max(0, now().getTime() - startedAt), event: 'error', error_category: 'api_validation' });
      return res.status(400).json({ error: 'invalid_event', issues: parsed.error.issues });
    }
    const events = readEvents(file);
    const session = events.find(event => event.kind === 'session' && event.sid === req.params.sid);
    const withdrawn = events.some(event => event.kind === 'withdrawal' && event.sid === req.params.sid);
    if (!session || withdrawn) return res.status(404).json({ error: 'session_not_found' });
    const startedAt = sessionStartedAt.get(req.params.sid);
    if (startedAt === undefined) return res.status(409).json({ error: 'session_inactive_after_restart' });
    const isFinished = events.some(event => event.sid === req.params.sid && event.kind === 'event' && ['task_complete', 'task_abandon', 'cancel'].includes(String(event.event)));
    if (isFinished) return res.status(409).json({ error: 'session_finished' });
    const elapsed = Math.max(0, now().getTime() - startedAt);
    const badTransition = (error: string) => {
      append({ kind: 'event', sid: req.params.sid, elapsed_total_ms: elapsed, event: 'error', error_category: 'state_transition' });
      return res.status(409).json({ error });
    };
    let durationMs: number | undefined;
    const startsPhase = parsed.data.event === 'phase_start';
    const endsPhase = parsed.data.event === 'phase_end';
    const startsActivity = parsed.data.event === 'activity_start';
    const endsActivity = parsed.data.event === 'activity_end';
    if (startsPhase || startsActivity) {
      if (startsPhase && activePhase.has(req.params.sid)) return badTransition('phase_already_active');
      if (startsActivity && activeActivity.has(req.params.sid)) return badTransition('activity_already_active');
      if (startsActivity && !activePhase.has(req.params.sid)) return badTransition('activity_requires_active_phase');
      if (startsPhase) activePhase.set(req.params.sid, { name: parsed.data.phase!, startedAt: now().getTime() });
      else activeActivity.set(req.params.sid, { name: parsed.data.category!, startedAt: now().getTime() });
    }
    if (endsPhase || endsActivity) {
      const expectedName = endsPhase ? parsed.data.phase! : parsed.data.category!;
      const current = endsPhase ? activePhase.get(req.params.sid) : activeActivity.get(req.params.sid);
      if (!current || current.name !== expectedName) return badTransition('span_mismatch');
      if (endsPhase && activeActivity.has(req.params.sid)) return badTransition('activity_must_end_before_phase');
      durationMs = Math.max(0, now().getTime() - current.startedAt);
      if (endsPhase) activePhase.delete(req.params.sid);
      else activeActivity.delete(req.params.sid);
    }
    if ((parsed.data.event === 'task_complete' || parsed.data.event === 'task_abandon' || parsed.data.event === 'cancel') && (activePhase.has(req.params.sid) || activeActivity.has(req.params.sid))) return badTransition('cannot_finish_with_active_span');
    const terminal = parsed.data.event === 'task_complete' || parsed.data.event === 'task_abandon' || parsed.data.event === 'cancel';
    append({ kind: 'event', sid: req.params.sid, elapsed_total_ms: elapsed, ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      event: parsed.data.event, ...(parsed.data.phase ? { phase: parsed.data.phase } : {}), ...(parsed.data.category ? { category: parsed.data.category } : {}),
      ...(parsed.data.operation ? { operation: parsed.data.operation } : {}), ...(parsed.data.error_category ? { error_category: parsed.data.error_category } : {}),
      ...(parsed.data.abandon_reason ? { abandon_reason: parsed.data.abandon_reason } : {}), ...(parsed.data.outcome ? { outcome: parsed.data.outcome } : {}) });
    if (terminal) { sessionStartedAt.delete(req.params.sid); activePhase.delete(req.params.sid); activeActivity.delete(req.params.sid); }
    res.status(201).json({ recorded: true, elapsed_total_ms: elapsed, ...(durationMs === undefined ? {} : { duration_ms: durationMs }) });
  });

  router.delete('/research-experiments/sessions/:sid', (req, res) => {
    if (!requireLocal(req, res)) return;
    pruneExpired();
    const events = readEvents(file);
    if (!events.some(event => event.kind === 'session' && event.sid === req.params.sid)) return res.status(404).json({ error: 'session_not_found' });
    const remaining = events.filter(event => event.sid !== req.params.sid);
    sessionStartedAt.delete(req.params.sid);
    activePhase.delete(req.params.sid);
    activeActivity.delete(req.params.sid);
    fs.mkdirSync(options.directory, { recursive: true });
    rewriteEvents(file, options.directory, remaining);
    res.json({ deleted: true });
  });

  router.delete('/research-experiments/events', (req, res) => {
    if (!requireLocal(req, res)) return;
    fs.rmSync(options.directory, { recursive: true, force: true });
    sessionStartedAt.clear();
    activePhase.clear();
    activeActivity.clear();
    res.json({ deleted: true });
  });
  return router;
}

const allowedLocalHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
function parseLocalHttpAuthority(value: string) {
  if (!value || value.length > 255 || /[\s/@\\]/u.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !allowedLocalHostnames.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch { return null; }
}

export function isTrustedLocalRequest(input: { remoteAddress: string; localAddress: string; host: string; origin?: string }) {
  if (!isLoopbackAddress(input.remoteAddress) || !isLoopbackAddress(input.localAddress)) return false;
  const host = parseLocalHttpAuthority(input.host);
  if (!host) return false;
  if (input.origin === undefined) return true;
  if (input.origin.length > 2048) return false;
  try {
    const origin = new URL(input.origin);
    if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    const originAuthority = parseLocalHttpAuthority(origin.host);
    return Boolean(originAuthority && origin.host.toLowerCase() === host.host.toLowerCase());
  } catch { return false; }
}

