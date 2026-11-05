import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tokenizeMorphological } from '../../bm25_engine.js';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';

const [datasetArg, indexArg] = process.argv.slice(2);
if (!datasetArg || !indexArg) throw new Error('Usage: tsx scripts/bench/audit_beir_candidate_recall.ts <dataset-dir> <index.sqlite>');
const datasetDir = path.resolve(datasetArg);
const database = new Database(path.resolve(indexArg), { readonly: true });
const queries = fs.readFileSync(path.join(datasetDir, 'queries.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as { _id: string; text: string });
const qrels = new Map<string, string[]>();
for (const line of fs.readFileSync(path.join(datasetDir, 'qrels', 'test.tsv'), 'utf8').split(/\r?\n/u)) {
  if (!line.trim() || line.startsWith('query-id')) continue;
  const [queryId, documentId, grade] = line.split('\t');
  if (!queryId || !documentId || Number(grade) <= 0 || queryId === documentId) continue;
  qrels.set(queryId, [...(qrels.get(queryId) ?? []), documentId]);
}
const hasPosting = database.prepare('SELECT 1 FROM postings WHERE term=? AND doc_id=? LIMIT 1');
const hasFts = database.prepare('SELECT 1 FROM morphology_fts WHERE morphology_fts MATCH ? AND id=? LIMIT 1');
const encodeToken = (token: string) => `m${Buffer.from(token, 'utf8').toString('hex')}`;
let total = 0;
let standardFound = 0;
let ftsFound = 0;
let unionFound = 0;
for (const query of queries) {
  const relevant = qrels.get(query._id) ?? [];
  if (!relevant.length) continue;
  const words = await purposeWords(query.text);
  const parsed = analyzeQuery(query.text, words.length ? words : query.text.split(/\s+/u).filter(Boolean),
    term => purposeTermWeight(term) === 3 ? 1.5 : 1);
  const terms = [...new Set(await tokenizeMorphological([...new Set(parsed.keywords.map(item => item.term))].join(' ')))];
  const ftsExpression = [...new Set(terms)].map(encodeToken).map(token => `"${token}"`).join(' OR ');
  for (const documentId of relevant) {
    total++;
    const standardCandidate = terms.some(term => hasPosting.get(term, documentId));
    const ftsCandidate = Boolean(ftsExpression && hasFts.get(ftsExpression, documentId));
    if (standardCandidate) standardFound++;
    if (ftsCandidate) ftsFound++;
    if (standardCandidate || ftsCandidate) unionFound++;
  }
}
database.close();
console.log(JSON.stringify({ positiveQrels: total, standardCandidateRecall: standardFound / total,
  ftsCandidateRecall: ftsFound / total, unionCandidateRecall: unionFound / total }, null, 2));
