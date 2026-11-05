import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve('quality/e2e/local/jacwir-experiment');
const parquet = path.join(root, 'collection-00000-of-00001.parquet');
const evalParquet = path.join(root, 'eval-00000-of-00001.parquet');
const duckdb = path.join(root, 'duckdb-cli', 'duckdb.exe');
const offset = Number(process.argv[2] ?? 100);
const outputName = process.argv[3] ?? `full-retrieval-queries-${offset + 1}-${offset + 100}`;
const skipCorpus = process.argv[4] === '--skip-corpus';
const queryCount = Number(process.argv[5] ?? 100);
if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(queryCount) || queryCount < 1 || !/^[a-z0-9-]+$/iu.test(outputName)) throw new Error('Usage: node prepare_jacwir_full_retrieval.mjs [query-offset] [output-name] [--skip-corpus] [query-count]');
const output = path.join(root, outputName);
if (![parquet, evalParquet, duckdb].every(file => fs.existsSync(file))) throw new Error('JaCWIR parquet or DuckDB CLI is missing from the local experiment directory.');
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing dataset: ${output}`);
fs.mkdirSync(output, { recursive: true });
const sqlPath = value => value.replaceAll('\\', '/').replaceAll("'", "''");
const run = sql => execFileSync(duckdb, ['-c', sql], { stdio: 'inherit' });
const corpusOut = sqlPath(path.join(output, 'corpus.jsonl'));
const queryOut = sqlPath(path.join(output, 'queries-with-positives.jsonl'));
const corpusIn = sqlPath(parquet);
const evalIn = sqlPath(evalParquet);

if (!skipCorpus) run(`COPY (SELECT doc_id AS _id, title, description AS text FROM read_parquet('${corpusIn}')) TO '${corpusOut}' (FORMAT JSON);`);
run(`COPY (
  WITH distinct_queries AS (SELECT DISTINCT query FROM read_parquet('${evalIn}'))
  SELECT sha256(query) AS _id, query AS text
  FROM distinct_queries ORDER BY _id LIMIT ${queryCount} OFFSET ${offset}
) TO '${queryOut}' (FORMAT JSON);`);
run(`COPY (
  WITH distinct_queries AS (SELECT DISTINCT query FROM read_parquet('${evalIn}')),
  selected AS (
    SELECT query, sha256(query) AS query_id
    FROM distinct_queries ORDER BY query_id LIMIT ${queryCount} OFFSET ${offset}
  )
  SELECT selected.query_id AS query_id, eval.positive AS doc_id, 1 AS relevance
  FROM selected JOIN read_parquet('${evalIn}') AS eval USING (query)
  ORDER BY query_id, doc_id
) TO '${sqlPath(path.join(output, 'qrels.jsonl') )}' (FORMAT JSON);`);

const queryRows = fs.readFileSync(path.join(output, 'queries-with-positives.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const qrelRows = fs.readFileSync(path.join(output, 'qrels.jsonl'), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
if (queryRows.length !== queryCount || new Set(queryRows.map(row => row._id)).size !== queryCount) throw new Error(`Expected ${queryCount} distinct queries, received ${queryRows.length}.`);
const queryIds = new Set(queryRows.map(row => row._id));
if (qrelRows.some(row => !queryIds.has(row.query_id)) || !qrelRows.length) throw new Error('Qrels include an unselected query or are empty.');
fs.writeFileSync(path.join(output, 'queries.jsonl'), queryRows.map(row => `${JSON.stringify(row)}\n`).join(''), { flag: 'wx' });
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify({
  source: 'hotchpotch/JaCWIR', sourceFiles: ['collection-00000-of-00001.parquet', 'eval-00000-of-00001.parquet'],
  task: `full-corpus known-positive retrieval; ${queryRows.length} hash-selected queries; every source positive for a selected query is retained`,
  querySelection: `distinct query strings ordered by SHA-256(query), rows ${offset + 1}-${offset + queryCount}`,
  queryCount: queryRows.length, positiveJudgmentCount: qrelRows.length, queryStringsWithMultipleKnownPositives: qrelRows.length - queryRows.length,
  corpusDocumentCount: skipCorpus ? null : 513107, corpusFile: skipCorpus ? null : 'corpus.jsonl', qrelsFile: 'qrels.jsonl',
  warning: 'Source qrels are not exhaustive over the full corpus; metrics are known-positive retrieval rates, not exhaustive relevance judgments.',
}, null, 2)}\n`, { flag: 'wx' });
fs.rmSync(path.join(output, 'queries-with-positives.jsonl'));
console.log(JSON.stringify({ output, queryCount: queryRows.length, positiveJudgmentCount: qrelRows.length, queryOffset: offset, corpusCopied: !skipCorpus }, null, 2));
