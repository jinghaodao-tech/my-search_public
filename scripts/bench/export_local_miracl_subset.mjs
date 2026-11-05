import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const repoRoot = process.cwd();
const sourceDb = path.resolve('data/bench/miracl-ja.db');
const evalPath = path.resolve('data/bench/miracl-ja.eval.json');
const outputRoot = path.resolve('quality/e2e/local/miracl-ja-e5');
if (!sourceDb.startsWith(repoRoot) || !evalPath.startsWith(repoRoot) || !outputRoot.startsWith(path.resolve('quality/e2e/local'))) {
  throw new Error('Refusing to access paths outside the repository benchmark inputs and ignored local output.');
}
for (const file of [sourceDb, evalPath]) if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
for (const file of ['corpus.jsonl', 'queries.jsonl', path.join('qrels', 'test.tsv'), 'manifest.json']) {
  if (fs.existsSync(path.join(outputRoot, file))) throw new Error(`Refusing to overwrite existing output: ${path.join(outputRoot, file)}`);
}

const evaluation = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
const queries = evaluation.queries;
const qrels = evaluation.qrels;
if (!Array.isArray(queries) || !qrels || typeof qrels !== 'object') throw new Error('Unexpected MIRACL evaluation JSON shape.');
const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
try {
  const articles = db.prepare("SELECT id,title,body FROM articles WHERE source='bench:miracl-ja' ORDER BY id").all();
  if (articles.length !== evaluation.documents) throw new Error(`Expected ${evaluation.documents} MIRACL subset documents, found ${articles.length}.`);
  const articleIds = new Set(articles.map(row => row.id));
  const positiveQrelsAbsentFromCorpus = [];
  let positiveQrelCount = 0;
  const qrelLines = ['query-id\tcorpus-id\tscore'];
  for (const query of queries) {
    const judgments = qrels[String(query.id)];
    if (!judgments || typeof judgments !== 'object') throw new Error(`Missing qrels for query ${query.id}.`);
    for (const [rawDocId, score] of Object.entries(judgments)) {
      const docId = `bench-miracl-ja-${rawDocId}`;
      if (Number(score) > 0) {
        positiveQrelCount++;
        if (!articleIds.has(docId)) positiveQrelsAbsentFromCorpus.push({ queryId: String(query.id), docId });
      }
      qrelLines.push(`${query.id}\t${docId}\t${score}`);
    }
  }
  fs.mkdirSync(path.join(outputRoot, 'qrels'), { recursive: true });
  const corpus = fs.createWriteStream(path.join(outputRoot, 'corpus.jsonl'), { flags: 'wx' });
  for (const row of articles) corpus.write(`${JSON.stringify({ _id: row.id, title: row.title, text: row.body })}\n`);
  corpus.end();
  await new Promise((resolve, reject) => { corpus.once('finish', resolve); corpus.once('error', reject); });
  fs.writeFileSync(path.join(outputRoot, 'queries.jsonl'), `${queries.map(query => JSON.stringify({ _id: String(query.id), text: query.text })).join('\n')}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'qrels', 'test.tsv'), `${qrelLines.join('\n')}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({
    source: 'existing local MIRACL-ja prepared subset, data/bench/miracl-ja.db + miracl-ja.eval.json',
    corpusKind: '29,937-document sampled subset; not official full-corpus evaluation',
    documents: articles.length, queries: queries.length, positiveQrelCount, positiveQrelsAbsentFromCorpus,
    qrelRows: qrelLines.length - 1,
  }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputRoot, documents: articles.length, queries: queries.length, positiveQrelCount,
    positiveQrelsAbsentFromCorpus: positiveQrelsAbsentFromCorpus.length, originalDatabaseOpenedReadOnly: true }, null, 2));
} finally {
  db.close();
}
