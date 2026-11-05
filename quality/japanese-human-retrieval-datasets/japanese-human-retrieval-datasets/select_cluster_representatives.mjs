#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const SELECTION_SALT = 'miracl-ja-holdout-representative-v1';
export function chooseRepresentatives(rows, expectedSplit = 'holdout') {
  const seen = new Set();
  const winners = new Map();
  for (const row of rows) {
    const id = String(row.id ?? '');
    const group = String(row.group_id ?? '');
    if (!id || !group || seen.has(id)) throw new Error('Missing/duplicate query id or missing group id');
    seen.add(id);
    if (row.split !== expectedSplit) continue;
    const digest = crypto.createHash('sha256').update(`${SELECTION_SALT}\0${id}`).digest('hex');
    const current = winners.get(group);
    if (!current || digest < current.digest) winners.set(group, {digest, row});
  }
  if (!winners.size) throw new Error(`No rows found for expected split: ${expectedSplit}`);
  return [...winners.values()].map(item => item.row).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function main() {
  const [inputArg, outputArg, split = 'holdout'] = process.argv.slice(2);
  if (!inputArg || !outputArg) throw new Error('Usage: node select_cluster_representatives.mjs <split.jsonl> <new-output.jsonl> [expected-split]');
  const input = path.resolve(inputArg);
  const output = path.resolve(outputArg);
  const sidecar = `${output}.selection.json`;
  if (fs.existsSync(output) || fs.existsSync(sidecar)) throw new Error('Refusing to overwrite representative selection artifacts');
  const raw = fs.readFileSync(input);
  const rows = raw.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!rows.length) throw new Error('Input split is empty');
  const selected = chooseRepresentatives(rows, split);
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const selectedIdsOnly = selected.map(row => ({id: String(row.id), group_id: String(row.group_id), split: row.split}));
  const serialized = `${selectedIdsOnly.map(row => JSON.stringify(row)).join('\n')}\n`;
  fs.writeFileSync(output, serialized, {encoding: 'utf8', flag: 'wx'});
  const manifest = {
    method: 'minimum SHA-256 per group_id; query outcomes and qrels are not inputs to selection',
    salt: SELECTION_SALT,
    expectedSplit: split,
    sourcePath: input,
    sourceSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    sourceQueryCount: rows.length,
    selectedQueryCount: selectedIdsOnly.length,
    clusterCount: new Set(selectedIdsOnly.map(row => row.group_id)).size,
    selectedJsonlSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    selectedIdsSha256: crypto.createHash('sha256').update(selectedIdsOnly.map(row => row.id).join('\n')).digest('hex'),
  };
  fs.writeFileSync(sidecar, `${JSON.stringify(manifest, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { console.error(error); process.exitCode = 1; });
