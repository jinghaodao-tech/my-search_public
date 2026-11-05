import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceRoot = path.resolve('local_article_corpus/api_dataset');
const outputRoot = path.resolve('quality/e2e/local/japanese-article-metadata-e5');
if (fs.existsSync(outputRoot)) throw new Error(`Refusing to overwrite existing export: ${outputRoot}`);
const inputPaths = ['documents.jsonl', 'development.jsonl', 'validation.jsonl', 'provenance.json']
  .map(name => path.join(sourceRoot, name));
for (const input of inputPaths) if (!fs.existsSync(input)) throw new Error(`Missing source file: ${input}`);
const readJsonl = file => fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const documents = readJsonl(path.join(sourceRoot, 'documents.jsonl'));
const development = readJsonl(path.join(sourceRoot, 'development.jsonl'));
const validation = readJsonl(path.join(sourceRoot, 'validation.jsonl'));
const documentIds = new Set();
for (const document of documents) {
  if (!document.id || documentIds.has(document.id) || typeof document.title !== 'string') throw new Error(`Invalid or duplicate document: ${document.id}`);
  documentIds.add(document.id);
}
for (const [split, queries] of [['development', development], ['validation', validation]]) {
  const queryIds = new Set();
  for (const query of queries) {
    if (!query.id || queryIds.has(query.id) || typeof query.query !== 'string' || !Array.isArray(query.gold_ids) || !query.gold_ids.length) {
      throw new Error(`Invalid ${split} query: ${query.id}`);
    }
    queryIds.add(query.id);
    for (const goldId of query.gold_ids) if (!documentIds.has(goldId)) throw new Error(`Missing positive document ${goldId} for ${query.id}`);
  }
}
const jsonl = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const corpus = documents.map(document => ({ _id: document.id, title: document.title,
  text: `${document.body ?? ''} Tags: ${(document.tags ?? []).join(' ')}`.trim() }));
const queries = [...development, ...validation].map(query => ({ _id: query.id, text: query.query }));
const writeNew = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx' });
};
fs.mkdirSync(path.join(outputRoot, 'qrels'), { recursive: true });
writeNew(path.join(outputRoot, 'corpus.jsonl'), jsonl(corpus));
writeNew(path.join(outputRoot, 'queries.jsonl'), jsonl(queries));
for (const [split, rows] of [['dev', development], ['test', validation]]) {
  const qrels = ['query-id\tcorpus-id\tscore'];
  for (const query of rows) for (const goldId of query.gold_ids) qrels.push(`${query.id}\t${goldId}\t1`);
  writeNew(path.join(outputRoot, 'qrels', `${split}.tsv`), `${qrels.join('\n')}\n`);
}
const manifest = {
  dataset: 'Japanese public technical article metadata',
  warning: 'Queries are automatically derived from title/tag metadata; this is not natural user-query evidence.',
  sourceDirectory: sourceRoot,
  sourceReadOnly: true,
  sourceFilesSha256: Object.fromEntries(inputPaths.map(file => [path.basename(file), sha256(file)])),
  documents: corpus.length,
  developmentQueries: development.length,
  validationQueries: validation.length,
  qrelsSplitMapping: { dev: 'development', test: 'validation' },
  queryOrigins: [...new Set([...development, ...validation].map(query => query.query_origin))],
  documentFields: 'title + body summary + tags; no full article text',
  positiveQrelsMissingFromCorpus: 0,
};
writeNew(path.join(outputRoot, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ outputRoot, manifest }, null, 2));
