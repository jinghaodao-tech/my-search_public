import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [splitPathArg, queryPathArg, qrelsPathArg, selectedPathArg, outputPathArg] = process.argv.slice(2);
if (![splitPathArg, queryPathArg, qrelsPathArg, selectedPathArg, outputPathArg].every(Boolean)) {
  throw new Error('Usage: node prepare_miracl_holdout_representatives.mjs <splits.jsonl> <queries.jsonl> <qrels.tsv> <selected-ids.jsonl> <new-enriched-output.jsonl>');
}
const readJsonl = file => fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const selected = readJsonl(selectedPathArg);
const selectedById = new Map();
for (const row of selected) {
  const id = String(row.id ?? '');
  const groupId = String(row.group_id ?? '');
  if (!id || !groupId || row.split !== 'holdout' || selectedById.has(id)) throw new Error(`Invalid selected representative row: ${id}`);
  selectedById.set(id, {id, group_id: groupId});
}
if (selectedById.size !== 726 || new Set([...selectedById.values()].map(row => row.group_id)).size !== 726) {
  throw new Error(`Expected exactly 726 unique holdout component representatives, got ${selectedById.size}`);
}

const queryById = new Map();
for (const row of readJsonl(queryPathArg)) {
  const id = String(row.id ?? '');
  if (!selectedById.has(id)) continue;
  if (queryById.has(id) || typeof row.query !== 'string' || !row.query.trim()) throw new Error(`Invalid or duplicate representative query: ${id}`);
  queryById.set(id, row.query);
}
if (queryById.size !== selectedById.size) throw new Error(`Missing selected queries: ${selectedById.size - queryById.size}`);

const goldByQuery = new Map([...selectedById.keys()].map(id => [id, []]));
for (const line of fs.readFileSync(path.resolve(qrelsPathArg), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [qid, _iteration, documentId, relevance] = line.trim().split(/\s+/);
  if (!goldByQuery.has(qid) || Number(relevance) <= 0) continue;
  if (documentId) goldByQuery.get(qid).push(documentId);
}

const rows = [...selectedById.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({id, group_id}) => {
  const gold_ids = [...new Set(goldByQuery.get(id))].sort();
  const query = queryById.get(id);
  if (!gold_ids.length || !query) throw new Error(`Representative lacks query or positive qrel: ${id}`);
  return {id, group_id, query, gold_ids};
});
const output = path.resolve(outputPathArg);
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
fs.mkdirSync(path.dirname(output), {recursive: true});
const serialized = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
fs.writeFileSync(output, serialized, {encoding: 'utf8', flag: 'wx'});
console.log(JSON.stringify({
  representativeCount: rows.length,
  positiveQrelCount: rows.reduce((sum, row) => sum + row.gold_ids.length, 0),
  selectedIdsSha256: crypto.createHash('sha256').update(rows.map(row => row.id).join('\n')).digest('hex'),
  enrichedJsonlSha256: crypto.createHash('sha256').update(serialized).digest('hex'),
  output,
}, null, 2));
