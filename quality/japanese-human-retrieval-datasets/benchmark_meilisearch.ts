import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const [command, databaseArg, datasetArg, outputArg, limitArg] = process.argv.slice(2);
const baseUrl = (process.env.MEILI_URL ?? 'http://127.0.0.1:17700').replace(/\/$/, '');
const apiKey = process.env.MEILI_MASTER_KEY ?? '';
const indexUid = process.env.MEILI_INDEX_UID ?? 'miracl-ja-v1550-full';
const sourceTable = process.env.MEILI_SOURCE_TABLE ?? 'articles';
const datasetName = process.env.MEILI_DATASET_NAME ?? 'MIRACL Japanese';
const databasePath = databaseArg ? path.resolve(databaseArg) : '';
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const toEngineId = (sourceId: string) => `m-${Buffer.from(sourceId, 'utf8').toString('base64url')}`;
const fromEngineId = (engineId: string) => Buffer.from(engineId.slice(2), 'base64url').toString('utf8');

if (!['import', 'evaluate'].includes(command ?? '')) {
  throw new Error('Usage: benchmark_meilisearch.ts <import|evaluate> <isolated.sqlite> [queries.jsonl] [output.json] [query-limit]');
}
if (!apiKey) throw new Error('Set MEILI_MASTER_KEY for the isolated local service.');
if (!databasePath || !fs.existsSync(databasePath)) throw new Error('An existing isolated SQLite corpus is required.');
if (!['articles', 'cards'].includes(sourceTable)) throw new Error('MEILI_SOURCE_TABLE must be articles or cards.');

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : {};
}

async function waitForTask(uid: number) {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const task = await jsonRequest(`${baseUrl}/tasks/${uid}`);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed' || task.status === 'canceled') throw new Error(`Meilisearch task ${uid} ${task.status}: ${JSON.stringify(task.error)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Meilisearch task ${uid}`);
}

async function importAll() {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  try {
    const sourceCount = sourceTable === 'articles'
      ? (db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n
      : (db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
    if (sourceTable === 'articles' && sourceCount !== 6_953_614) throw new Error(`Expected the full MIRACL source corpus (6,953,614 docs); found ${sourceCount}.`);
    const maxDocuments = limitArg ? Number.parseInt(limitArg, 10) : sourceCount;
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) throw new Error('document-limit must be a positive integer.');
    const targetCount = Math.min(maxDocuments, sourceCount);
    const stats = await jsonRequest(`${baseUrl}/indexes/${indexUid}/stats`).catch(() => null);
    if (stats) throw new Error(`Refusing to reuse non-empty/existing Meilisearch index ${indexUid}. Use a fresh MEILI_INDEX_UID and DB path.`);
    const created = await jsonRequest(`${baseUrl}/indexes`, { method: 'POST', body: JSON.stringify({ uid: indexUid, primaryKey: 'id' }) });
    await waitForTask(created.taskUid);
    const settings = await jsonRequest(`${baseUrl}/indexes/${indexUid}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ searchableAttributes: ['title', 'body'], displayedAttributes: ['id', 'title'] }),
    });
    await waitForTask(settings.taskUid);

    const readBatch = db.prepare(`SELECT id,title,body FROM ${sourceTable} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    let cursor = 0;
    let imported = 0;
    let batchCount = 0;
    let queued: number[] = [];
    const started = performance.now();
    while (imported < targetCount) {
      const rows = readBatch.all(cursor, Math.min(5000, targetCount - imported)) as Array<{id:string;title:string;body:string}>;
      if (!rows.length) break;
      cursor = Number((db.prepare(`SELECT rowid AS r FROM ${sourceTable} WHERE id=?`).get(rows.at(-1)!.id) as {r:number}).r);
      const documents = rows.map(row => ({ ...row, id: toEngineId(row.id.replace(/^(miracl-ja-|benchmark-)/, '')) }));
      const result = await jsonRequest(`${baseUrl}/indexes/${indexUid}/documents?primaryKey=id`, { method: 'POST', body: JSON.stringify(documents) });
      queued.push(result.taskUid);
      imported += rows.length;
      batchCount += 1;
      if (queued.length >= 8 || imported === targetCount) {
        await Promise.all(queued.map(waitForTask));
        queued = [];
      }
      if (imported % 100_000 < rows.length || imported === targetCount) {
        console.log(JSON.stringify({ imported, total: targetCount, elapsedSeconds: Math.round((performance.now() - started) / 1000), rssBytes: process.memoryUsage().rss }));
      }
    }
    const result = {
      engine: 'Meilisearch', version: '1.55.0', dataset: datasetName, sourceTable, sourceDocumentCount: sourceCount,
      importedDocumentCount: imported, requestedDocumentCount: targetCount, batchCount, elapsedMs: performance.now() - started,
      engineStats: await jsonRequest(`${baseUrl}/indexes/${indexUid}/stats`),
      indexSettings: await jsonRequest(`${baseUrl}/indexes/${indexUid}/settings`),
      rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
      hostTotalMemoryBytes: os.totalmem(), hostFreeMemoryBytes: os.freemem(), databasePath,
    };
    const output = outputArg ? path.resolve(outputArg) : '';
    if (output) fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

async function evaluate() {
  if (!datasetArg || !outputArg) throw new Error('evaluate requires <queries.jsonl> and <output.json>.');
  const rawQueries = fs.readFileSync(path.resolve(datasetArg), 'utf8').trim();
  const parsed = rawQueries.startsWith('{') ? JSON.parse(rawQueries) : rawQueries.split(/\r?\n/).map(line => JSON.parse(line));
  const all = Array.isArray(parsed) ? parsed : parsed.all_results ?? parsed.outcomes ?? [];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : all.length;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('query-limit must be a positive integer.');
  const queries = all.slice(0, limit);
  const outcomes: Array<Record<string, unknown>> = [];
  for (const [i, query] of queries.entries()) {
    const started = performance.now();
    try {
      const result = await jsonRequest(`${baseUrl}/indexes/${indexUid}/search`, {
        method: 'POST', body: JSON.stringify({ q: query.query, limit: 1000, attributesToRetrieve: ['id'] }),
      });
      const ids = result.hits.map((hit: {id:string}) => fromEngineId(hit.id));
      const goldIds = query.gold_ids ?? query.expected ?? (query.expected_id ? [query.expected_id] : []);
      const gold = new Set(goldIds as string[]);
      const rank = ids.findIndex((id: string) => gold.has(id));
      const dcg = ids.slice(0, 10).reduce((sum: number, id: string, pos: number) => sum + (gold.has(id) ? 1 / Math.log2(pos + 2) : 0), 0);
      const ideal = Array.from({length: Math.min(gold.size, 10)}, (_, pos) => 1 / Math.log2(pos + 2)).reduce((a, b) => a + b, 0);
      outcomes.push({
        qid: query.id ?? query.qid, group_id: query.group_id ?? query.groupId, query: query.query, gold_ids: goldIds,
        hitAt1: rank === 0, hitAt10: rank >= 0 && rank < 10, hitAt100: rank >= 0 && rank < 100,
        hitAt1000: rank >= 0, firstRelevantRank: rank < 0 ? null : rank + 1,
        mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0,
        ndcg10: ideal > 0 ? dcg / ideal : 0, latencyMs: performance.now() - started,
        totalHits: result.estimatedTotalHits ?? null, top10: ids.slice(0, 10), error: null,
      });
    } catch (error) {
      outcomes.push({ qid: query.id ?? query.qid, group_id: query.group_id ?? query.groupId, query: query.query, gold_ids: query.gold_ids ?? query.expected,
        hitAt1: false, hitAt10: false, hitAt100: false, hitAt1000: false, firstRelevantRank: null,
        mrr10: 0, ndcg10: 0, latencyMs: performance.now() - started, error: String(error) });
    }
    if ((i + 1) % 50 === 0 || i + 1 === queries.length) console.log(JSON.stringify({ completed: i + 1, total: queries.length }));
  }
  const latencies = outcomes.map(item => item.latencyMs as number).sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)];
  const rate = (key: string) => outcomes.filter(item => item[key] === true).length / outcomes.length;
  const result = {
    dataset: `${datasetName}; raw-query external-engine evaluation`, engine: 'Meilisearch', version: '1.55.0',
    indexUid, databasePath, sourceDocumentCount: (await jsonRequest(`${baseUrl}/indexes/${indexUid}/stats`)).numberOfDocuments,
    queryCount: outcomes.length, errors: outcomes.filter(item => item.error).length,
    metrics: { hitAt1: rate('hitAt1'), hitAt10: rate('hitAt10'), hitAt100: rate('hitAt100'), hitAt1000: rate('hitAt1000'),
      mrr10: outcomes.reduce((sum, item) => sum + (item.mrr10 as number), 0) / outcomes.length,
      ndcg10: outcomes.reduce((sum, item) => sum + (item.ndcg10 as number), 0) / outcomes.length },
    latencyMs: {p50: percentile(0.5), p95: percentile(0.95)},
    clientPeakRssBytes: process.resourceUsage().maxRSS * 1024, clientHeapUsedBytes: process.memoryUsage().heapUsed,
    hostTotalMemoryBytes: os.totalmem(), hostFreeMemoryBytes: os.freemem(), outcomes,
  };
  fs.writeFileSync(path.resolve(outputArg), `${JSON.stringify(result, null, 2)}\n`);
  const { outcomes: _outcomes, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
}

if (command === 'import') await importAll();
else await evaluate();
