import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('local_article_corpus/japanese-human-retrieval/jagov');
const outputRoot = path.resolve('quality/e2e/local/jagov-e5-transfer');
if (fs.existsSync(outputRoot)) throw new Error(`Refusing to overwrite existing export: ${outputRoot}`);
const manifestPath = path.join(sourceRoot, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const inputNames = ['corpus.jsonl', 'queries.jsonl', 'qrels.tsv', 'splits.jsonl'];
for (const name of inputNames) {
  const file = path.join(sourceRoot, name);
  if (!fs.existsSync(file)) throw new Error(`Missing source file: ${file}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== manifest.sha256[name]) throw new Error(`Official manifest hash mismatch for ${name}`);
}
const readJsonl = name => fs.readFileSync(path.join(sourceRoot, name), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const corpusSource = readJsonl('corpus.jsonl');
const queriesSource = readJsonl('queries.jsonl');
const splitsSource = readJsonl('splits.jsonl');
if (corpusSource.length !== manifest.document_count || queriesSource.length !== manifest.query_count) throw new Error('Manifest row-count mismatch.');
const docs = new Map();
for (const row of corpusSource) {
  const id = String(row.id);
  if (docs.has(id) || typeof row.text !== 'string') throw new Error(`Invalid or duplicate document ${id}`);
  docs.set(id, { _id: id, title: row.title ?? '', text: row.text });
}
const queryById = new Map();
for (const row of queriesSource) {
  const id = String(row.id);
  if (queryById.has(id) || typeof row.query !== 'string') throw new Error(`Invalid or duplicate query ${id}`);
  queryById.set(id, row.query);
}
const splitById = new Map();
for (const row of splitsSource) {
  const id = String(row.id);
  if (splitById.has(id) || !queryById.has(id) || !['development', 'validation', 'holdout'].includes(row.split)) throw new Error(`Invalid split row ${id}`);
  splitById.set(id, { groupId: String(row.group_id), split: row.split });
}
const judgmentsByQuery = new Map();
for (const [lineIndex, line] of fs.readFileSync(path.join(sourceRoot, 'qrels.tsv'), 'utf8').split(/\r?\n/u).entries()) {
  if (!line.trim()) continue;
  const [queryIdRaw, _iteration, docIdRaw, gradeRaw] = line.split(/\s+/u);
  const queryId = String(queryIdRaw ?? '');
  const docId = String(docIdRaw ?? '');
  const grade = Number(gradeRaw);
  if (!queryById.has(queryId) || !docs.has(docId) || !Number.isFinite(grade)) throw new Error(`Invalid qrels row ${lineIndex + 1}`);
  const rows = judgmentsByQuery.get(queryId) ?? [];
  rows.push([docId, grade]);
  judgmentsByQuery.set(queryId, rows);
}
if (judgmentsByQuery.size !== manifest.query_count || splitById.size !== manifest.query_count) throw new Error('Query, qrels, and split coverage mismatch.');
const idsBySplit = Object.fromEntries(['development', 'validation', 'holdout'].map(split => [split,
  [...splitById].filter(([, value]) => value.split === split).map(([id]) => id)]));
for (const split of Object.keys(idsBySplit)) if (idsBySplit[split].length !== manifest.split_counts[split]) throw new Error(`Wrong ${split} count.`);
const exportedSplits = [['dev', 'development'], ['test', 'validation']];
const jsonl = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const writeNew = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
};
const exportedQueryIds = new Set(exportedSplits.flatMap(([, original]) => idsBySplit[original]));
const exportedQueries = [...exportedQueryIds].map(id => ({ _id: id, text: queryById.get(id) }));
fs.mkdirSync(path.join(outputRoot, 'qrels'), { recursive: true });
writeNew(path.join(outputRoot, 'corpus.jsonl'), jsonl([...docs.values()]));
writeNew(path.join(outputRoot, 'queries.jsonl'), jsonl(exportedQueries));
for (const [targetSplit, sourceSplit] of exportedSplits) {
  const rows = [`query-id\tcorpus-id\tscore`];
  for (const queryId of idsBySplit[sourceSplit]) for (const [docId, grade] of judgmentsByQuery.get(queryId) ?? []) rows.push(`${queryId}\t${docId}\t${grade}`);
  writeNew(path.join(outputRoot, 'qrels', `${targetSplit}.tsv`), `${rows.join('\n')}\n`);
}
const exportedPositiveCount = [...exportedQueryIds].reduce((sum, id) => sum + (judgmentsByQuery.get(id) ?? []).filter(([, grade]) => grade > 0).length, 0);
const sourceHashes = Object.fromEntries(inputNames.map(name => [name, manifest.sha256[name]]));
const outputManifest = {
  dataset: 'JaGovFaqsRetrieval',
  source: 'official split corpus/query/qrels release; CC BY 4.0',
  sourceRoot,
  sourceFilesSha256: sourceHashes,
  sourceReadOnly: true,
  sourceRevision: manifest.source_revision,
  exportedDocuments: docs.size,
  developmentQueries: idsBySplit.development.length,
  validationQueries: idsBySplit.validation.length,
  holdoutQueriesExported: idsBySplit.holdout.filter(id => exportedQueryIds.has(id)).length,
  qrelsSplitMapping: { dev: 'development', test: 'validation' },
  exportedPositiveQrels: exportedPositiveCount,
  positiveQrelsMissingFromCorpus: 0,
  queryAuthorship: 'official FAQ questions; not observed my-search search logs',
  disclaimer: 'Evaluation is exploratory transfer only. The preregistered holdout split was intentionally excluded.',
};
writeNew(path.join(outputRoot, 'source-manifest.json'), `${JSON.stringify(outputManifest, null, 2)}\n`);
console.log(JSON.stringify({ outputRoot, manifest: outputManifest }, null, 2));
