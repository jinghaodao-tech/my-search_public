import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chooseRepresentatives} from './select_cluster_representatives.mjs';
import {clopperPearsonLower, evaluateRepresentativeHits} from './evaluate_representative_gate.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('representative selection is deterministic and selects one per group', () => {
  const rows = [
    {id: 'q1', group_id: 'g1', split: 'holdout'},
    {id: 'q2', group_id: 'g1', split: 'holdout'},
    {id: 'q3', group_id: 'g2', split: 'holdout'},
    {id: 'q4', group_id: 'g3', split: 'development'},
  ];
  const selected = chooseRepresentatives(rows);
  assert.deepEqual(selected, chooseRepresentatives([...rows].reverse()));
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map(row => row.group_id)).size, 2);
});

test('exact lower bound is finite and crosses the declared threshold only when supported', () => {
  assert.ok(clopperPearsonLower(702, 726, .025) > .95);
  assert.ok(clopperPearsonLower(701, 726, .025) <= .95);
});

test('gate and paired cluster comparison count failures and discordant clusters', () => {
  const representatives = Array.from({length: 8}, (_, i) => ({id: `q${i}`, group_id: `g${i}`}));
  const candidate = new Map(representatives.map(row => [row.id, true]));
  const baseline = new Map(representatives.map((row, i) => [row.id, i < 6]));
  const report = evaluateRepresentativeHits(representatives, candidate, baseline, {target: .5, alpha: .05, bootstrap: 100, seed: 7});
  assert.equal(report.status, 'PASS');
  assert.equal(report.pairedComparison.improvedClusters, 2);
  assert.equal(report.pairedComparison.worsenedClusters, 0);
  assert.equal(report.pairedComparison.exactMcNemarTwoSidedP, .5);
});

test('repeated target groups are rejected instead of treated as independent', () => {
  const reps = [{id: 'q1', group_id: 'g'}, {id: 'q2', group_id: 'g'}];
  assert.throws(() => evaluateRepresentativeHits(reps, new Map(), null), /exactly one query per cluster/);
});

test('CLI writes immutable selection and gate artifacts from complete synthetic inputs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'miracl-representative-test-'));
  try {
    const source = path.join(directory, 'holdout.jsonl');
    const selected = path.join(directory, 'selected.jsonl');
    const candidate = path.join(directory, 'candidate.jsonl');
    const rows = [
      {id: 'q1', group_id: 'g1', split: 'holdout', query: 'x', gold_ids: ['d1']},
      {id: 'q2', group_id: 'g1', split: 'holdout', query: 'y', gold_ids: ['d2']},
      {id: 'q3', group_id: 'g2', split: 'holdout', query: 'z', gold_ids: ['d3']},
    ];
    writeFileSync(source, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const select = spawnSync(process.execPath, ['./select_cluster_representatives.mjs', source, selected], {cwd: HERE, encoding: 'utf8'});
    assert.equal(select.status, 0, select.stderr);
    const selectedRows = readFileSync(selected, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    writeFileSync(candidate, `${selectedRows.map(row => JSON.stringify({qid: row.id, hit10: true})).join('\n')}\n`);
    const evaluate = spawnSync(process.execPath, ['./evaluate_representative_gate.mjs', '--representatives', selected, '--candidate', candidate, '--target', '.1'], {cwd: HERE, encoding: 'utf8'});
    assert.equal(evaluate.status, 0, evaluate.stderr);
    assert.equal(JSON.parse(evaluate.stdout).status, 'PASS');
    assert.ok(readFileSync(`${selected}.selection.json`, 'utf8').includes('selectedIdsSha256'));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
