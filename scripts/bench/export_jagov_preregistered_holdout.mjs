import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('local_article_corpus/japanese-human-retrieval/jagov');
const outputRoot = path.resolve('quality/e2e/local/jagov-e5-holdout-preregistered-20261024-v2');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
if (manifest.dataset !== 'jagov' || manifest.split_counts?.holdout !== 1024 || manifest.split_group_counts?.holdout !== 1024) {
  throw new Error('Official JaGov manifest does not match the preregistered 1,024-query holdout.');
}
if (fs.existsSync(outputRoot)) throw new Error(`Refusing to overwrite existing holdout export: ${outputRoot}`);

const inputNames = ['corpus.jsonl', 'queries.jsonl', 'qrels.tsv', 'splits.jsonl'];
const hashes = Object.fromEntries(inputNames.map(name => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex');
  if (digest !== manifest.sha256[name]) throw new Error(`Official input hash mismatch: ${name}`);
  return [name, digest];
}));
const readJsonl = name => fs.readFileSync(path.join(sourceRoot, name), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const corpus = readJsonl('corpus.jsonl');
const queries = readJsonl('queries.jsonl');
const splits = readJsonl('splits.jsonl');
if (corpus.length !== 22794 || queries.length !== 2048 || splits.length !== queries.length) throw new Error('Official source row counts differ from the manifest.');
const queryText = new Map(queries.map(row => [String(row.id), row.query]));
const selected = new Map(splits.filter(row => row.split === 'holdout').map(row => [String(row.id), String(row.group_id)]));
if (selected.size !== 1024 || new Set(selected.values()).size !== 1024) throw new Error('Holdout query/group counts differ from the preregistration.');
for (const id of selected.keys()) if (!queryText.has(id)) throw new Error(`Holdout query text is missing: ${id}`);

const documents = new Set(corpus.map(row => String(row.id)));
const positivesByQuery = new Map([...selected.keys()].map(id => [id, []]));
let qrelRows = 0;
for (const [lineIndex, line] of fs.readFileSync(path.join(sourceRoot, 'qrels.tsv'), 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim()) continue;
  const [queryIdRaw, , docIdRaw, gradeRaw] = line.split(/\s+/u);
  const queryId = String(queryIdRaw ?? '');
  const docId = String(docIdRaw ?? '');
  const grade = Number(gradeRaw);
  if (!queryText.has(queryId) || !documents.has(docId) || !Number.isFinite(grade)) throw new Error(`Invalid official qrel at line ${lineIndex + 1}.`);
  if (!selected.has(queryId)) continue;
  positivesByQuery.get(queryId).push([docId, grade]);
  qrelRows += 1;
}
if ([...positivesByQuery.values()].some(rows => rows.length === 0)) throw new Error('At least one holdout query has no qrel.');

fs.mkdirSync(outputRoot, { recursive: false });
const writeNew = (name, content) => fs.writeFileSync(path.join(outputRoot, name), content, { flag: 'wx' });
writeNew('corpus.jsonl', `${corpus.map(row => JSON.stringify({ _id: String(row.id), title: row.title ?? '', text: row.text })).join('\n')}\n`);
writeNew('queries.jsonl', `${[...selected.keys()].map(id => JSON.stringify({ _id: id, text: queryText.get(id) })).join('\n')}\n`);
const qrels = ['query-id\tcorpus-id\tscore'];
for (const [id, rows] of positivesByQuery) for (const [docId, grade] of rows) qrels.push(`${id}\t${docId}\t${grade}`);
fs.mkdirSync(path.join(outputRoot, 'qrels'));
fs.writeFileSync(path.join(outputRoot, 'qrels', 'test.tsv'), `${qrels.join('\n')}\n`, { flag: 'wx' });
const selectionHash = crypto.createHash('sha256').update([...selected].map(([id, group]) => `${id}\t${group}`).join('\n')).digest('hex');
writeNew('source-manifest.json', `${JSON.stringify({
  dataset: 'JaGovFaqsRetrieval', sourceRevision: manifest.source_revision, split: 'holdout',
  queryCount: selected.size, connectedTargetGroups: new Set(selected.values()).size,
  qrelCount: qrelRows, corpusDocumentCount: corpus.length, positiveQrelsAbsentFromCorpus: 0,
  holdoutGroupSelectionSha256: selectionHash, sourceFileSha256: hashes,
  corpusTransformation: 'The source corpus is unchanged; export maps id to _id and preserves title/text for the evaluator schema.',
  disclaimer: 'Official FAQ questions, not my-search user search sessions. Evaluated once under preregistered BM25/E5/RRF settings.',
}, null, 2)}\n`);
console.log(JSON.stringify({ outputRoot, queryCount: selected.size, groupCount: new Set(selected.values()).size, qrelCount: qrelRows, corpusDocuments: corpus.length, selectionHash }, null, 2));
