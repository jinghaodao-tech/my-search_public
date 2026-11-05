import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeExperimentEvents, verifyE6ParallelForms, verifySyntheticTasks } from '../quality/e0e6/analysis.mjs';
import { buildE6Schedule } from '../quality/e0e6/build_schedule.mjs';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../quality/e0e6/synthetic_tasks.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const forms = fixture.e6_parallel_forms;

test('synthetic tasks and parallel E6 forms have isolated IDs, consistent source labels, and deterministic tool answer keys', () => {
  assert.equal(verifySyntheticTasks(fixture.tasks).task_count, 3);
  assert.equal(verifyE6ParallelForms(forms).form_count, 3);
  assert.throws(() => verifySyntheticTasks([{ ...fixture.tasks[0], task_id: 'private-article-title' }]));
  assert.throws(() => verifyE6ParallelForms([{ ...forms[0], tool: { ...forms[0].tool, expected_result: -1 } }, ...forms.slice(1)]));
  assert.deepEqual(fixture.e6_workflow_conditions, ['mvp', 'separated', 'integrated']);
});

test('analysis reports totals, activities, operations, errors, success, dropout and incomplete sessions without double counting', () => {
  const summary = analyzeExperimentEvents([
    { kind: 'session', sid: 's1', experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-a', condition: { workflow: 'separated' } },
    { kind: 'event', sid: 's1', event: 'phase_start', phase: 'compare', elapsed_total_ms: 0 },
    { kind: 'event', sid: 's1', event: 'activity_start', category: 'management', elapsed_total_ms: 10 },
    { kind: 'event', sid: 's1', event: 'activity_end', category: 'management', duration_ms: 120, elapsed_total_ms: 130 },
    { kind: 'event', sid: 's1', event: 'activity_start', category: 'verification', elapsed_total_ms: 140 },
    { kind: 'event', sid: 's1', event: 'activity_end', category: 'verification', duration_ms: 200, elapsed_total_ms: 340 },
    { kind: 'event', sid: 's1', event: 'activity_start', category: 'correction', elapsed_total_ms: 350 },
    { kind: 'event', sid: 's1', event: 'activity_end', category: 'correction', duration_ms: 50, elapsed_total_ms: 400 },
    { kind: 'event', sid: 's1', event: 'phase_end', phase: 'compare', elapsed_total_ms: 900 },
    { kind: 'event', sid: 's1', event: 'management_operation', operation: 'manual_reentry', elapsed_total_ms: 910 },
    { kind: 'event', sid: 's1', event: 'error', error_category: 'task_failure', elapsed_total_ms: 920 },
    { kind: 'event', sid: 's1', event: 'task_complete', outcome: 'success', elapsed_total_ms: 1000 },
    { kind: 'session', sid: 's2', experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-b', condition: { workflow: 'integrated' } },
    { kind: 'event', sid: 's2', event: 'task_abandon', abandon_reason: 'participant_choice', elapsed_total_ms: 500 },
    { kind: 'session', sid: 's3', experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-c', condition: { workflow: 'integrated' } },
  ]);
  assert.deepEqual(summary, {
    session_count: 3, completed_count: 1, success_count: 1, success_rate: 1,
    abandoned_count: 1, incomplete_count: 1, dropout_rate: 1 / 3, error_count: 1,
    management_operation_count: 1, elapsed_total_ms: [1000, 500],
    management_time_ms: [120, 0, 0], verification_time_ms: [200, 0, 0], correction_time_ms: [50, 0, 0],
    by_condition: [
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-a', workflow_definition_id: null,
        condition: { workflow: 'separated' }, session_count: 1, completed_count: 1, success_count: 1, success_rate: 1,
        abandoned_count: 0, incomplete_count: 0, dropout_rate: 0, error_count: 1, management_operation_count: 1,
        elapsed_total_ms: [1000], management_time_ms: [120], verification_time_ms: [200], correction_time_ms: [50] },
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-b', workflow_definition_id: null,
        condition: { workflow: 'integrated' }, session_count: 1, completed_count: 0, success_count: 0, success_rate: null,
        abandoned_count: 1, incomplete_count: 0, dropout_rate: 1, error_count: 0, management_operation_count: 0,
        elapsed_total_ms: [500], management_time_ms: [0], verification_time_ms: [0], correction_time_ms: [0] },
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-c', workflow_definition_id: null,
        condition: { workflow: 'integrated' }, session_count: 1, completed_count: 0, success_count: 0, success_rate: null,
        abandoned_count: 0, incomplete_count: 1, dropout_rate: 0, error_count: 0, management_operation_count: 0,
        elapsed_total_ms: [], management_time_ms: [0], verification_time_ms: [0], correction_time_ms: [0] },
    ],
    sessions: [
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-a', workflow_definition_id: null,
        condition: { workflow: 'separated' }, operation_count: 1, error_count: 1, durations: { management: 120, verification: 200, correction: 50 },
        outcome: 'success', elapsed_total_ms: 1000, terminal_event: 'task_complete', open_phase: null, open_activity: null, phase_count: 1, activity_count: 3 },
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-b', workflow_definition_id: null,
        condition: { workflow: 'integrated' }, operation_count: 0, error_count: 0, durations: { management: 0, verification: 0, correction: 0 },
        outcome: 'abandoned', elapsed_total_ms: 500, terminal_event: 'task_abandon', open_phase: null, open_activity: null, phase_count: 0, activity_count: 0 },
      { experiment: 'E6', task_id: 'synthetic-integrate-01', presentation_id: 'synthetic-form-c', workflow_definition_id: null,
        condition: { workflow: 'integrated' }, operation_count: 0, error_count: 0, durations: { management: 0, verification: 0, correction: 0 },
        outcome: null, elapsed_total_ms: null, terminal_event: null, open_phase: null, open_activity: null, phase_count: 0, activity_count: 0 },
    ],
    accounting: { total_is_terminal_wall_time_only: true, subdurations_added_to_total: false,
      success_rate_denominator: 'completed sessions only', dropout_rate_denominator: 'all started sessions', incomplete_sessions_are_not_dropouts: true },
  });
  assert.throws(() => analyzeExperimentEvents([
    { kind: 'session', sid: 'x' },
    { kind: 'event', sid: 'x', event: 'task_complete', outcome: 'success', elapsed_total_ms: 10 },
    { kind: 'event', sid: 'x', event: 'task_abandon', elapsed_total_ms: 11 },
  ]), /event after terminal event/u);
  assert.throws(() => analyzeExperimentEvents([
    { kind: 'session', sid: 'x' },
    { kind: 'event', sid: 'x', event: 'phase_end', phase: 'compare', elapsed_total_ms: 1 },
  ]), /unmatched phase end/u);
  assert.throws(() => analyzeExperimentEvents([
    { kind: 'session', sid: 'x' },
    { kind: 'event', sid: 'x', event: 'phase_start', phase: 'compare', elapsed_total_ms: 10 },
    { kind: 'event', sid: 'x', event: 'phase_end', phase: 'compare', elapsed_total_ms: 9 },
  ]), /decreasing elapsed time/u);
});

test('E6 schedule balances condition-by-form and condition-by-order position across six sequences', () => {
  const taskForms = forms.map(form => form.form_id);
  const first = buildE6Schedule({ seed: 'pilot-seed', taskForms });
  assert.deepEqual(buildE6Schedule({ seed: 'pilot-seed', taskForms }), first);
  assert.equal(first.sequence_count, 6);
  const pairCounts = new Map();
  const positionCounts = Array.from({ length: 3 }, () => new Map());
  const formPositionCounts = Array.from({ length: 3 }, () => new Map());
  for (const sequence of first.sequences) {
    assert.equal(sequence.items.length, 3);
    assert.ok(sequence.items.every(item => item.task_id === fixture.shared_e6_task.task_id && item.controlled_axes.authority === 'synthetic_only'));
    sequence.items.forEach((item, position) => {
      const pair = `${item.workflow}|${item.presentation_id}`;
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      positionCounts[position].set(item.workflow, (positionCounts[position].get(item.workflow) ?? 0) + 1);
      formPositionCounts[position].set(item.presentation_id, (formPositionCounts[position].get(item.presentation_id) ?? 0) + 1);
    });
  }
  assert.equal(pairCounts.size, 9);
  assert.ok([...pairCounts.values()].every(count => count === 2));
  for (const position of positionCounts) assert.deepEqual([...position.values()].sort(), [2, 2, 2]);
  for (const position of formPositionCounts) assert.deepEqual([...position.values()].sort(), [2, 2, 2]);
});
