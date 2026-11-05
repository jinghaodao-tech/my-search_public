import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { analyzeQuery } from '../../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../../services/discover_service.js';

type Query = { id: string; query: string; gold_ids: string[]; group_id: string };
type Row = { id: string; morphological_tokens_json: string; morphological_doc_length: number };

async function main() {
  const [dataDir, manifestFile, databaseFile, outputFile] = process.argv.slice(2);
  if (!dataDir || !manifestFile || !databaseFile || !outputFile) {
    throw new Error('Usage: standard_bm25_from_seeded_db.ts <dataset-dir> <manifest.json> <seeded.db> <output.json>');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { stage: string; group_ids: string[]; query_ids: string[] };
  const groupSet = new Set(manifest.group_ids);
  const querySet = new Set(manifest.query_ids);
  const queries = fs.readFileSync(path.join(dataDir, `${manifest.stage}.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Query).filter(query => groupSet.has(query.group_id) && querySet.has(query.id));
  if (queries.length !== manifest.query_ids.length || queries.some(query => !manifest.query_ids.includes(query.id))) {
    throw new Error('Manifest does not match dataset records');
  }

  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`SELECT id, morphological_tokens_json, morphological_doc_length FROM cards WHERE archived = 0`).all() as Row[];
  db.close();
  const docs = rows.map(row => {
    const tokens = JSON.parse(row.morphological_tokens_json || '[]') as string[];
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { id: row.id.replace(/^benchmark-/, ''), tokens, length: row.morphological_doc_length || tokens.length, tf };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(docs.length, 1);
  const results = [];
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const started = performance.now();
    const words = await purposeWords(query.query);
    const parsed = analyzeQuery(query.query, words.length ? words : query.query.split(/\s+/).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
    const scored: Array<{ id: string; score: number }> = [];
    for (const doc of docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term) ?? 0;
        if (!tf) continue;
        const frequency = df.get(term) ?? 0;
        const idf = Math.log((docs.length - frequency + 0.5) / (frequency + 0.5) + 1);
        score += idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * doc.length / Math.max(avgLength, 1)));
      }
      if (score > 0) scored.push({ id: doc.id, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const expected = new Set(query.gold_ids);
    const rank = scored.findIndex(item => expected.has(item.id) && item.score > 0) + 1 || null;
    results.push({ qid: query.id, groupId: query.group_id, expected: query.gold_ids, query: query.query,
      parserTerms: terms, rankTop10: rank && rank <= 10 ? rank : null,
      rankTop100: rank && rank <= 100 ? rank : null, rankTop1000: rank && rank <= 1000 ? rank : null,
      rankOverall: rank,
      candidateCount: scored.length, top10: scored.slice(0, 10).map(item => item.id), latencyMs: performance.now() - started });
    if ((index + 1) % 50 === 0) console.log(`standard BM25 ${index + 1}/${queries.length}`);
  }
  const output = { dataset: path.basename(path.resolve(dataDir)), stage: manifest.stage, queryCount: queries.length,
    documentCount: docs.length, method: 'Independent BM25 over app-stored morphology tokens; k1=1.2, b=0.75; no app ranking corrections; query parser shared with the application API.', results };
  const target = path.resolve(outputFile); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: target, queryCount: queries.length, documentCount: docs.length,
    hitAt1: results.filter(result => result.rankTop10 === 1).length,
    hitAt10: results.filter(result => result.rankTop10 !== null).length,
    hitAt100: results.filter(result => result.rankTop100 !== null).length,
    hitAt1000: results.filter(result => typeof result.rankTop1000 === 'number' && result.rankTop1000 <= 1000).length,
    latencyMsP50: percentile(results.map(result => result.latencyMs), .5),
    latencyMsP95: percentile(results.map(result => result.latencyMs), .95) }));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(2) ?? 0);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
