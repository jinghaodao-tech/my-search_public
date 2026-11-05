const durationKinds = new Set(['management', 'verification', 'correction']);
const terminalEvents = new Set(['task_complete', 'task_abandon', 'cancel']);

function summarizeSessions(rows) {
  const completed = rows.filter(session => session.terminal_event === 'task_complete');
  const successes = completed.filter(session => session.outcome === 'success').length;
  const abandoned = rows.filter(session => session.terminal_event === 'task_abandon' || session.terminal_event === 'cancel').length;
  const terminal = rows.filter(session => session.terminal_event !== null);
  return {
    session_count: rows.length,
    completed_count: completed.length,
    success_count: successes,
    success_rate: completed.length ? successes / completed.length : null,
    abandoned_count: abandoned,
    incomplete_count: rows.length - terminal.length,
    dropout_rate: rows.length ? abandoned / rows.length : null,
    error_count: rows.reduce((sum, session) => sum + session.error_count, 0),
    management_operation_count: rows.reduce((sum, session) => sum + session.operation_count, 0),
    elapsed_total_ms: terminal.map(session => session.elapsed_total_ms),
    management_time_ms: rows.map(session => session.durations.management),
    verification_time_ms: rows.map(session => session.durations.verification),
    correction_time_ms: rows.map(session => session.durations.correction),
  };
}

function conditionKey(session) {
  return JSON.stringify({ experiment: session.experiment, task_id: session.task_id,
    presentation_id: session.presentation_id ?? null, workflow_definition_id: session.workflow_definition_id ?? null,
    condition: session.condition ?? {} });
}

export function analyzeExperimentEvents(events) {
  const sessions = new Map();
  for (const event of events) {
    if (event.kind === 'session') {
      if (typeof event.sid !== 'string' || !event.sid || sessions.has(event.sid)) throw new Error(`duplicate or invalid session ${event.sid}`);
      sessions.set(event.sid, { sid: event.sid, experiment: event.experiment, task_id: event.task_id,
        presentation_id: event.presentation_id ?? null, workflow_definition_id: event.workflow_definition_id ?? null,
        condition: event.condition ?? {}, operation_count: 0, error_count: 0,
        durations: Object.fromEntries([...durationKinds].map(kind => [kind, 0])), outcome: null,
        elapsed_total_ms: null, terminal_event: null, lastElapsedMs: -1, activePhase: null, activeActivity: null,
        phaseCount: 0, activityCount: 0 });
      continue;
    }
    if (event.kind !== 'event') throw new Error(`unknown event kind ${event.kind}`);
    const session = sessions.get(event.sid);
    if (!session) throw new Error(`event has no session ${event.sid}`);
    if (!Number.isFinite(event.elapsed_total_ms) || event.elapsed_total_ms < session.lastElapsedMs) throw new Error(`invalid or decreasing elapsed time ${event.sid}`);
    if (session.terminal_event) throw new Error(`event after terminal event ${event.sid}`);
    const elapsed = event.elapsed_total_ms;
    session.lastElapsedMs = elapsed;
    if (event.event === 'management_operation') session.operation_count += 1;
    if (event.event === 'error') session.error_count += 1;

    if (event.event === 'phase_start') {
      if (session.activePhase || session.activeActivity) throw new Error(`overlapping phase ${event.sid}`);
      session.activePhase = { name: event.phase, elapsed };
      session.phaseCount += 1;
    } else if (event.event === 'phase_end') {
      if (!session.activePhase || session.activePhase.name !== event.phase || session.activeActivity) throw new Error(`unmatched phase end ${event.sid}`);
      session.activePhase = null;
    } else if (event.event === 'activity_start') {
      if (!session.activePhase || session.activeActivity || !durationKinds.has(event.category)) throw new Error(`unmatched activity start ${event.sid}`);
      session.activeActivity = { name: event.category, elapsed };
      session.activityCount += 1;
    } else if (event.event === 'activity_end') {
      if (!session.activeActivity || session.activeActivity.name !== event.category || !Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
        throw new Error(`unmatched or invalid activity end ${event.sid}`);
      }
      const observedElapsed = elapsed - session.activeActivity.elapsed;
      // The route takes wall-clock readings for duration and total elapsed separately.
      if (Math.abs(observedElapsed - event.duration_ms) > 100) throw new Error(`activity duration disagrees with event timeline ${event.sid}`);
      session.durations[event.category] += event.duration_ms;
      session.activeActivity = null;
    } else if (terminalEvents.has(event.event)) {
      if (session.activePhase || session.activeActivity) throw new Error(`terminal event with an open span ${event.sid}`);
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error(`invalid terminal duration ${event.sid}`);
      session.terminal_event = event.event;
      session.elapsed_total_ms = elapsed;
      session.outcome = event.event === 'task_complete' ? event.outcome : event.event === 'task_abandon' ? 'abandoned' : 'cancelled';
    }
  }

  const rows = [...sessions.values()];
  const byCondition = new Map();
  for (const session of rows) {
    const key = conditionKey(session);
    const group = byCondition.get(key) ?? { experiment: session.experiment, task_id: session.task_id,
      presentation_id: session.presentation_id, workflow_definition_id: session.workflow_definition_id, condition: session.condition, rows: [] };
    group.rows.push(session);
    byCondition.set(key, group);
  }
  const conditionSummaries = [...byCondition.values()].map(group => ({
    experiment: group.experiment, task_id: group.task_id, presentation_id: group.presentation_id,
    workflow_definition_id: group.workflow_definition_id, condition: group.condition,
    ...summarizeSessions(group.rows),
  }));
  return {
    ...summarizeSessions(rows),
    by_condition: conditionSummaries,
    sessions: rows.map(({ sid: _sid, lastElapsedMs: _elapsed, activePhase, activeActivity, phaseCount, activityCount,
      ...session }) => ({ ...session, open_phase: activePhase?.name ?? null, open_activity: activeActivity?.name ?? null,
      phase_count: phaseCount, activity_count: activityCount })),
    accounting: {
      total_is_terminal_wall_time_only: true,
      subdurations_added_to_total: false,
      success_rate_denominator: 'completed sessions only',
      dropout_rate_denominator: 'all started sessions',
      incomplete_sessions_are_not_dropouts: true,
    },
  };
}

export function verifySyntheticTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Synthetic task list must not be empty');
  const ids = new Set();
  for (const task of tasks) {
    if (typeof task.task_id !== 'string' || !/^synthetic-[a-z0-9-]+$/u.test(task.task_id) || ids.has(task.task_id)) throw new Error('Invalid or duplicate synthetic task id');
    ids.add(task.task_id);
    if (!['E0', 'E6'].includes(task.experiment) || !Array.isArray(task.phases) || task.phases.length === 0) throw new Error(`Invalid task ${task.task_id}`);
    if (task.expected_outcome !== 'success') throw new Error(`Missing synthetic answer key for ${task.task_id}`);
  }
  return { task_count: tasks.length, task_ids: [...ids] };
}

export function verifyE6ParallelForms(forms) {
  if (!Array.isArray(forms) || forms.length !== 3) throw new Error('E6 requires three parallel forms for counterbalance checks');
  const ids = new Set();
  for (const form of forms) {
    if (!/^synthetic-form-[a-c]$/u.test(form.form_id) || ids.has(form.form_id)) throw new Error('Invalid or duplicate E6 presentation id');
    ids.add(form.form_id);
    if (!form.source?.id?.startsWith('SYS-') || !Array.isArray(form.fact_choices) || !form.fact_choices.includes(form.expected_fact)) throw new Error(`Invalid source or answer key in ${form.form_id}`);
    if (form.tool?.kind !== 'fixed_addition' || form.tool.left + form.tool.right !== form.tool.expected_result) throw new Error(`Tool result mismatch in ${form.form_id}`);
    if (form.expected_saved_source_id !== form.source.id) throw new Error(`Saved source mismatch in ${form.form_id}`);
  }
  return { form_count: ids.size, presentation_ids: [...ids] };
}
