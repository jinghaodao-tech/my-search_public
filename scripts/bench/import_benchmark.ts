/**
 * Load a public IR benchmark into an ISOLATED my-search database, for comparing search with and
 * without Chrome's on-device AI (scripts/bench/README.md). The original files are only read.
 *
 *   npx tsx scripts/bench/import_benchmark.ts --beir <scifact.zip> --name scifact
 *   npx tsx scripts/bench/import_benchmark.ts --miracl <ir_benchmark_originals> --name miracl-ja --queries 200 --docs 30000
 *
 * Writes data/bench/<name>.db (articles, source "bench:<name>") and data/bench/<name>.eval.json
 * (queries + qrels). Never touches data/cards.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const name = arg('name');
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error('--name <lowercase-name> is required');
const outDir = path.resolve(arg('out', 'data/bench')!);
fs.mkdirSync(outDir, { recursive: true });
const dbPath = path.join(outDir, `${name}.db`);
if (path.resolve(dbPath) === path.resolve('data/cards.db')) throw new Error('refusing to write the real database');
if (fs.existsSync(dbPath) || fs.existsSync(path.join(outDir, `${name}.eval.json`))) {
  throw new Error(`refusing to overwrite existing benchmark output: ${name}`);
}
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
process.env.DB_PATH = dbPath;
process.env.KJ_FILE = path.join(outDir, `${name}.kj.json`);

type Doc = { id: string; title: string; text: string };
type Qrels = Record<string, Record<string, number>>;

// ─── a small zip reader (stored / deflate), enough for the BEIR archives ──────
function readZip(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error(`not a zip file: ${file}`);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const entry = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    if (!entry.endsWith('/')) files.set(entry, method === 0 ? raw : zlib.inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
const jsonl = (text: string) => text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

function loadBeir(zipFile: string, split: string) {
  const files = readZip(zipFile);
  const find = (suffix: string) => [...files.keys()].find(key => key.endsWith(suffix));
  const corpusKey = find('corpus.jsonl'); const queriesKey = find('queries.jsonl'); const qrelsKey = find(`qrels/${split}.tsv`);
  if (!corpusKey || !queriesKey || !qrelsKey) throw new Error(`corpus.jsonl / queries.jsonl / qrels/${split}.tsv not found in ${zipFile}`);
  const docs: Doc[] = jsonl(files.get(corpusKey)!.toString('utf8')).map(row => ({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') }));
  const allQueries = new Map(jsonl(files.get(queriesKey)!.toString('utf8')).map(row => [String(row._id), String(row.text)]));
  const qrels: Qrels = {};
  for (const line of files.get(qrelsKey)!.toString('utf8').split('\n').slice(1)) {
    const [qid, docid, score] = line.trim().split('\t');
    if (!qid || !docid) continue;
    (qrels[qid] ??= {})[docid] = Number(score);
  }
  const queries = Object.keys(qrels).filter(qid => allQueries.has(qid)).map(qid => ({ id: qid, text: allQueries.get(qid)! }));
  return { docs, queries, qrels };
}

function loadJagov(root: string, split: string) {
  const allowed = new Set(['development', 'validation', 'holdout']);
  if (!allowed.has(split)) throw new Error(`unsupported JAGOV split: ${split}`);
  const docs: Doc[] = jsonl(fs.readFileSync(path.join(root, 'documents.jsonl'), 'utf8'))
    .map(row => ({ id: String(row.id), title: String(row.title ?? ''), text: String(row.body ?? '') }));
  const rows = jsonl(fs.readFileSync(path.join(root, `${split}.jsonl`), 'utf8'));
  const queries = rows.map(row => ({ id: String(row.id), text: String(row.query) }));
  const qrels: Qrels = Object.fromEntries(rows.map(row => [
    String(row.id), Object.fromEntries((row.gold_ids as string[]).map(id => [String(id), 1])),
  ]));
  return { docs, queries, qrels };
}

// Deterministic sample (same seed → same queries)
function seeded(seed: number) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

async function loadMiracl(root: string, maxQueries: number, maxDocs: number) {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const all = walk(root);
  const topicsFile = all.find(file => /topics\.miracl-v1\.0-ja-dev\.tsv$/.test(file));
  const qrelsFile = all.find(file => /qrels\.miracl-v1\.0-ja-dev\.tsv$/.test(file));
  const corpusFiles = all.filter(file => /miracl-corpus-v1\.0-ja[\\/].*\.jsonl(\.gz)?$/.test(file)).sort();
  if (!topicsFile || !qrelsFile) throw new Error('MIRACL ja dev topics/qrels not found (run the download with --miracl-ja-labels)');
  if (!corpusFiles.length) throw new Error('MIRACL ja corpus not found (run the download with --miracl-ja-full)');
  const topics = new Map(fs.readFileSync(topicsFile, 'utf8').split('\n').filter(Boolean).map(line => { const [id, ...rest] = line.split('\t'); return [id, rest.join('\t')] as [string, string]; }));
  const qrels: Qrels = {};
  for (const line of fs.readFileSync(qrelsFile, 'utf8').split('\n')) {
    const [qid, , docid, rel] = line.trim().split(/\s+/);
    if (qid && docid) (qrels[qid] ??= {})[docid] = Number(rel);
  }
  const random = seeded(20261019);
  const ids = Object.keys(qrels).filter(qid => topics.has(qid) && Object.values(qrels[qid]).some(rel => rel > 0));
  for (let i = ids.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const chosen = ids.slice(0, maxQueries);
  const judged = new Set(chosen.flatMap(qid => Object.keys(qrels[qid])));
  // judged passages of the chosen questions + other passages drawn evenly from the whole corpus
  const docs: Doc[] = [];
  const fillerRate = Math.min(1, (maxDocs - judged.size) / 6_950_000);
  for (const file of corpusFiles) {
    const input = fs.createReadStream(file).pipe(file.endsWith('.gz') ? zlib.createGunzip() : new PassThrough());
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line) continue;
      const row = JSON.parse(line);
      const id = String(row.docid);
      if (judged.has(id) || (docs.length < maxDocs && random() < fillerRate)) docs.push({ id, title: String(row.title ?? ''), text: String(row.text ?? '') });
    }
    process.stdout.write(`\r  read ${path.basename(file)} — ${docs.length} passages kept`);
  }
  process.stdout.write('\n');
  const kept = new Set(docs.map(doc => doc.id));
  const missing = [...judged].filter(id => !kept.has(id)).length;
  if (missing) console.warn(`  ${missing} judged passages were not found in the corpus files`);
  const subQrels: Qrels = Object.fromEntries(chosen.map(qid => [qid, qrels[qid]]));
  return { docs, queries: chosen.map(qid => ({ id: qid, text: topics.get(qid)! })), qrels: subQrels };
}

const started = Date.now();
const data = arg('beir') ? loadBeir(arg('beir')!, arg('split', 'test')!)
  : arg('miracl') ? await loadMiracl(arg('miracl')!, Number(arg('queries', '200')), Number(arg('docs', '30000')))
    : arg('jagov') ? loadJagov(arg('jagov')!, arg('split', 'development')!)
      : null;
if (!data) throw new Error('give --beir <zip>, --miracl <folder>, or --jagov <folder>');
const maxQ = Number(arg('max-queries', '0'));
const queries = maxQ > 0 ? data.queries.slice(0, maxQ) : data.queries;
console.log(`${name}: ${data.docs.length} documents, ${queries.length} queries`);

const { buildStoredTokenSet } = await import('../../bm25_engine.js');
const { saveArticlesToDb } = await import('../../repositories/articles_repository.js');
const source = `bench:${name}`;
const fixedDate = new Date('2026-01-01T00:00:00Z'); // same date for every document: no recency effect
const batch: unknown[] = [];
let done = 0;
for (const doc of data.docs) {
  const body = doc.text;
  const tokens = await buildStoredTokenSet(`${doc.title}\n${body}`);
  batch.push({
    id: `bench-${name}-${doc.id}`, title: doc.title || body.slice(0, 60), body, summary: body.slice(0, 200),
    url: `https://bench.invalid/${name}/${encodeURIComponent(doc.id)}`, source, sources: [source], sourceAuthority: 0.5,
    publishedAt: fixedDate, bodyKind: 'fulltext', tokens: tokens.ngramTokens, docLength: tokens.ngramDocLength, ...tokens,
  });
  if (batch.length >= 500) { saveArticlesToDb(batch.splice(0) as never); }
  done += 1;
  if (done % 1000 === 0) process.stdout.write(`\r  tokenised ${done}/${data.docs.length}`);
}
if (batch.length) saveArticlesToDb(batch as never);
process.stdout.write('\n');
fs.writeFileSync(path.join(outDir, `${name}.eval.json`), JSON.stringify({
  name, source, idPrefix: `bench-${name}-`, documents: data.docs.length,
  note: 'Subset / isolated copy for comparing my-search settings. Not comparable with official leaderboard scores.',
  queries, qrels: Object.fromEntries(queries.map(q => [q.id, data.qrels[q.id]])),
}));
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s → ${dbPath}`);
