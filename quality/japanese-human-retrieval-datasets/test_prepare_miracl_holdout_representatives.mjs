import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const prepare = path.join(here, 'prepare_miracl_holdout_representatives.mjs');
const select = path.join(here, 'japanese-human-retrieval-datasets', 'select_cluster_representatives.mjs');

test('holdout preparation joins queries and positive qrels only after ID selection', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'miracl-holdout-prepare-'));
  try {
    const splits = path.join(directory, 'splits.jsonl');
    const queries = path.join(directory, 'queries.jsonl');
    const qrels = path.join(directory, 'qrels.tsv');
    const selected = path.join(directory, 'selected.jsonl');
    const enriched = path.join(directory, 'enriched.jsonl');
    const rows = Array.from({length: 726}, (_, index) => ({id:`q${index}`, group_id:`g${index}`, split:'holdout'}));
    writeFileSync(splits, `${rows.map(row=>JSON.stringify(row)).join('\n')}\n`);
    writeFileSync(queries, `${rows.map(row=>JSON.stringify({id:row.id,query:`query ${row.id}`})).join('\n')}\n`);
    writeFileSync(qrels, `${rows.map((row,index)=>`${row.id}\t0\tdoc${index}\t1`).join('\n')}\n`);
    const chosen = spawnSync(process.execPath, [select, splits, selected], {encoding:'utf8'});
    assert.equal(chosen.status, 0, chosen.stderr);
    const selectedRows = readFileSync(selected, 'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
    assert.equal(selectedRows.length, 726);
    assert.ok(selectedRows.every(row=>Object.keys(row).sort().join(',')==='group_id,id,split'));
    const joined = spawnSync(process.execPath, [prepare, splits, queries, qrels, selected, enriched], {encoding:'utf8'});
    assert.equal(joined.status, 0, joined.stderr);
    const enrichedRows = readFileSync(enriched, 'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
    assert.equal(enrichedRows.length, 726);
    assert.deepEqual(enrichedRows[0], {id:'q0',group_id:'g0',query:'query q0',gold_ids:['doc0']});
    const duplicateJoin = spawnSync(process.execPath, [prepare, splits, queries, qrels, selected, enriched], {encoding:'utf8'});
    assert.notEqual(duplicateJoin.status, 0);
    assert.match(duplicateJoin.stderr, /Refusing to overwrite/);
  } finally {
    rmSync(directory, {recursive:true,force:true});
  }
});
