import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeExperimentEvents, verifyE6ParallelForms, verifySyntheticTasks } from './analysis.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'synthetic_tasks.json'), 'utf8'));
const taskCheck = verifySyntheticTasks(fixture.tasks);
const formsCheck = verifyE6ParallelForms(fixture.e6_parallel_forms);
const syntheticEvents = fixture.tasks.flatMap((task, index) => [
  { kind: 'session', sid: `synthetic-session-${index + 1}`, experiment: task.experiment, task_id: task.task_id,
    condition: { automation: 'manual', visibility: 'current', timing: 'on_request', workflow: task.experiment === 'E6' ? 'integrated' : 'mvp' } },
  ...task.phases.flatMap((phase, phaseIndex) => [
    { kind: 'event', sid: `synthetic-session-${index + 1}`, event: 'phase_start', phase, elapsed_total_ms: phaseIndex * 10 },
    { kind: 'event', sid: `synthetic-session-${index + 1}`, event: 'phase_end', phase, elapsed_total_ms: phaseIndex * 10 + 5 },
  ]),
  { kind: 'event', sid: `synthetic-session-${index + 1}`, event: 'task_complete', outcome: task.expected_outcome, elapsed_total_ms: 1000 + index * 100 },
]);
const summary = analyzeExperimentEvents(syntheticEvents);
if (summary.completed_count !== fixture.tasks.length || summary.success_count !== fixture.tasks.length) throw new Error('Synthetic analysis smoke check failed');
if (summary.elapsed_total_ms.length !== fixture.tasks.length) throw new Error('Elapsed total must be counted once per completed task');
console.log(JSON.stringify({ taskCheck, formsCheck, summary, evidence: 'synthetic_only' }, null, 2));
