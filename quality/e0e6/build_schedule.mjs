import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const counterbalanceMaps = [
  { map: ['mvp', 'separated', 'integrated'], orders: [[0, 1, 2], [0, 2, 1]] },
  { map: ['integrated', 'mvp', 'separated'], orders: [[2, 0, 1], [2, 1, 0]] },
  { map: ['separated', 'integrated', 'mvp'], orders: [[1, 0, 2], [1, 2, 0]] },
];

function rng(seed) {
  let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}

export function buildE6Schedule({ seed, taskForms }) {
  if (typeof seed !== 'string' || !seed.length) throw new Error('A non-empty seed is required for reproducibility');
  if (!Array.isArray(taskForms) || taskForms.length !== 3 || taskForms.some(form => !/^synthetic-form-[a-c]$/u.test(form))) throw new Error('Exactly three identified parallel synthetic task forms are required');
  const rows = [];
  for (const { map, orders } of counterbalanceMaps) for (const order of orders) {
    rows.push({ conditions: map, taskOrder: order.map(index => taskForms[index]) });
  }
  const random = rng(seed);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const sequences = rows.map((row, sequenceIndex) => ({
    sequence_id: `CB-${sequenceIndex + 1}`,
    items: row.taskOrder.map((presentationId, position) => ({
      position: position + 1,
      task_id: 'synthetic-integrate-01',
      presentation_id: presentationId,
      workflow: row.conditions[['synthetic-form-a', 'synthetic-form-b', 'synthetic-form-c'].indexOf(presentationId)],
      controlled_axes: { automation: 'manual', visibility: 'current', timing: 'on_request', authority: 'synthetic_only' },
    })),
  }));
  return { schema_version: 2, seed, purpose: 'balanced synthetic counterbalance wiring; sequence count is not a study sample-size recommendation', sequence_count: sequences.length, sequences };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const seedAt = args.indexOf('--seed');
  const seed = seedAt >= 0 ? args[seedAt + 1] : '';
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'synthetic_tasks.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  console.log(JSON.stringify(buildE6Schedule({ seed, taskForms: fixture.e6_parallel_forms.map(form => form.form_id) }), null, 2));
}
