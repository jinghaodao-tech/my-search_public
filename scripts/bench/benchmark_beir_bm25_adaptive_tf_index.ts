import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { buildAdaptiveTermModel, scoreAdaptiveBm25, type AdaptiveTermModel, type Posting } from './bm25_adaptive_tf.js';
import { scorePl2 } from './pl2.js';
import { reciprocalRankFusion } from './rrf.js';

type Document = { _id: string; title?: string; text?: string };
type Query = { _id: string; text: string };
type ScoredMode = 'standard' | 'adaptive-k1' | 'bm25-adpt' | 'pl2';
type Mode = ScoredMode | 'bm25-pl2-rrf';
type Metrics = { hit1: number; hit10: number; mrr10: number; ndcg10: number; map100: number; recall100: number };
type IndexedDocument = { id: string; length: number };
const [datasetArg, splitArg, indexArg, provenanceArg, outputArg] = process.argv.slice(2);
if (!datasetArg || !splitArg || !indexArg || !provenanceArg || !outputArg) {
  throw new Error('Usage: tsx scripts/bench/benchmark_beir_bm25_adaptive_tf_index.ts <dataset-dir> <train|dev> <read-only-index.sqlite> <index-provenance.json> <new-output.json>');
}
if (!['train', 'dev'].includes(splitArg)) throw new Error('Exploration is restricted to BEIR train/dev splits.');
const datasetDir = path.resolve(datasetArg);
const indexPath = path.resolve(indexArg);
const provenancePath = path.resolve(provenanceArg);
const outputPath = path.resolve(outputArg);
if (!outputPath.includes(`${path.sep}artifacts${path.sep}`) || fs.existsSync(outputPath)) throw new Error('Output must be a new path under artifacts/.');
const corpusPath = path.join(datasetDir, 'corpus.jsonl');
const queriesPath = path.join(datasetDir, 'queries.jsonl');
const qrelsPath = path.join(datasetDir, 'qrels', `${splitArg}.tsv`);
for (const file of [corpusPath, queriesPath, qrelsPath, indexPath, provenancePath]) if (!fs.existsSync(file)) throw new Error(`Missing benchmark input: ${file}`);
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = async function* <T>(file: string): AsyncGenerator<T> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as T;
};
const corpusHash = hashFile(corpusPath);
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8')) as { dataset?: { corpusSha256?: string; documents?: number } };
if (provenance.dataset?.corpusSha256 !== corpusHash) throw new Error('The prebuilt token index provenance is not for this exact corpus file.');

const database = new Database(indexPath, { readonly: true, fileMustExist: true });
try {
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Index integrity_check failed: ${String(integrity)}`);
  const documents: IndexedDocument[] = [];
  const documentIndex = new Map<string, number>();
  for (const row of database.prepare('SELECT id,length FROM documents ORDER BY id').iterate() as Iterable<{ id: string; length: number }>) {
    documentIndex.set(row.id, documents.length);
    documents.push({ id: row.id, length: row.length });
  }
  if (documents.length !== provenance.dataset?.documents) throw new Error('Index document count does not match its provenance.');
  const remainingIds = new Set(documentIndex.keys());
  for await (const document of readJsonl<Document>(corpusPath)) {
    if (!remainingIds.delete(document._id)) throw new Error(`Index is missing or duplicates corpus document ${document._id}.`);
  }
  if (remainingIds.size) throw new Error(`Index has ${remainingIds.size} documents absent from the corpus.`);

  const queriesById = new Map<string, string>();
  for await (const query of readJsonl<Query>(queriesPath)) queriesById.set(query._id, query.text);
  const qrelMap = new Map<string, Map<string, number>>();
  for (const [lineNumber, line] of fs.readFileSync(qrelsPath, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim() || line.startsWith('query-id')) continue;
    const [queryId, docId, scoreText] = line.split('\t');
    if (!queryId || !docId || !queriesById.has(queryId) || !Number.isFinite(Number(scoreText))) throw new Error(`Invalid qrels row ${lineNumber + 1}.`);
    const rows = qrelMap.get(queryId) ?? new Map<string, number>();
    rows.set(docId, Math.max(rows.get(docId) ?? 0, Number(scoreText)));
    qrelMap.set(queryId, rows);
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current) { parent.set(id, id); return id; }
    if (current === id) return id;
    const root = find(current); parent.set(id, root); return root;
  };
  for (const [queryId, judgments] of qrelMap) for (const [docId, grade] of judgments) if (grade > 0) {
    const left = find(`q:${queryId}`); const right = find(`d:${docId}`);
    if (left !== right) parent.set(right, left);
  }
  const qrels = [...qrelMap].map(([id, judgments]) => ({ id,
    groupId: parent.has(`q:${id}`) ? find(`q:${id}`) : `q:${id}`,
    judgments, text: queriesById.get(id)! }));
  if (!qrels.length) throw new Error(`No ${splitArg} qrels.`);

  const lengths = documents.map(document => document.length);
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length;
  const queryAnalysisMs: number[] = [];
  const allQueryTerms = new Set<string>();
  const queryRows: Array<typeof qrels[number] & { terms: string[] }> = [];
  for (const qrel of qrels) {
    const started = performance.now();
    const dictionaryWords = await purposeWords(qrel.text);
    const parsed = analyzeQuery(qrel.text, dictionaryWords.length ? dictionaryWords : qrel.text.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const terms = [...new Set(parsed.keywords.map(keyword => keyword.term))];
    queryAnalysisMs.push(performance.now() - started);
    for (const term of terms) allQueryTerms.add(term);
    queryRows.push({ ...qrel, terms });
  }

  const models = new Map<string, AdaptiveTermModel>();
  const collectionFrequencies = new Map<string, number>();
  const queryTermList = [...allQueryTerms];
  const modelStarted = performance.now();
  for (let offset = 0; offset < queryTermList.length; offset += 200) {
    const batch = queryTermList.slice(offset, offset + 200);
    const placeholders = batch.map(() => '?').join(',');
    const rows = database.prepare(`SELECT p.term,p.tf,d.length FROM postings p JOIN documents d ON d.id=p.doc_id WHERE p.term IN (${placeholders}) ORDER BY p.term`).all(...batch) as Array<{ term: string; tf: number; length: number }>;
    let currentTerm = '';
    let normalizedTfs: number[] = [];
    let currentCollectionFrequency = 0;
    const saveModel = () => {
      if (!currentTerm || !normalizedTfs.length) return;
      const model = buildAdaptiveTermModel(documents.length, normalizedTfs);
      if (model) models.set(currentTerm, model);
      collectionFrequencies.set(currentTerm, currentCollectionFrequency);
    };
    for (const row of rows) {
      if (currentTerm && row.term !== currentTerm) { saveModel(); normalizedTfs = []; currentCollectionFrequency = 0; }
      currentTerm = row.term;
      const normalizedTf = row.tf / (1 - 0.75 + 0.75 * row.length / Math.max(averageLength, 1));
      normalizedTfs.push(normalizedTf);
      currentCollectionFrequency += row.tf;
    }
    saveModel();
    if ((offset + batch.length) % 5000 < 200 || offset + batch.length === queryTermList.length) {
      console.log(`modelled ${Math.min(offset + batch.length, queryTermList.length)}/${queryTermList.length} query terms`);
    }
  }
  const modelBuildMs = performance.now() - modelStarted;

  const metric = (rankedIds: string[], judgments: Map<string, number>): Metrics => {
    const relevant = new Set([...judgments].filter(([, grade]) => grade > 0).map(([id]) => id));
    const rank = rankedIds.findIndex(id => relevant.has(id));
    let hits100 = 0; let precisionSum = 0;
    for (const [index, id] of rankedIds.slice(0, 100).entries()) {
      if (relevant.has(id)) { hits100++; precisionSum += hits100 / (index + 1); }
    }
    const dcg = rankedIds.slice(0, 10).reduce((sum, id, index) => sum + ((2 ** (judgments.get(id) ?? 0) - 1) / Math.log2(index + 2)), 0);
    const idealGrades = [...judgments.values()].sort((a, b) => b - a).slice(0, 10);
    const ideal = idealGrades.reduce((sum, grade, index) => sum + ((2 ** grade - 1) / Math.log2(index + 2)), 0);
    return { hit1: rank === 0 ? 1 : 0, hit10: rank >= 0 && rank < 10 ? 1 : 0,
      mrr10: rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0,
      ndcg10: ideal ? dcg / ideal : 0, map100: relevant.size ? precisionSum / relevant.size : 0,
      recall100: relevant.size ? hits100 / relevant.size : 0 };
  };

  const scoredModes: ScoredMode[] = ['standard', 'adaptive-k1', 'bm25-adpt', 'pl2'];
  const modes: Mode[] = [...scoredModes, 'bm25-pl2-rrf'];
  const outcomes: Record<Mode, Array<{ id: string; groupId: string; metrics: Metrics; top10: string[] }>> = { standard: [], 'adaptive-k1': [], 'bm25-adpt': [], pl2: [], 'bm25-pl2-rrf': [] };
  const latency: Record<Mode, number[]> = { standard: [], 'adaptive-k1': [], 'bm25-adpt': [], pl2: [], 'bm25-pl2-rrf': [] };
  const queryTerms = queryRows.map(row => row.terms);
  for (let queryIndex = 0; queryIndex < queryRows.length; queryIndex++) {
    const qrel = queryRows[queryIndex]!;
    const terms = queryTerms[queryIndex]!;
    const localPostings = new Map<string, Posting[]>();
    let fetchMs = 0;
    if (terms.length) {
      const fetchStarted = performance.now();
      const statement = database.prepare(`SELECT p.term,p.doc_id,p.tf FROM postings p WHERE p.term IN (${terms.map(() => '?').join(',')}) ORDER BY p.term`);
      const rows = statement.all(...terms) as Array<{ term: string; doc_id: string; tf: number }>;
      fetchMs = performance.now() - fetchStarted;
      for (const row of rows) {
        const docIndex = documentIndex.get(row.doc_id);
        if (docIndex === undefined) throw new Error(`Posting points to missing document ${row.doc_id}.`);
        let postingRows = localPostings.get(row.term);
        if (!postingRows) { postingRows = []; localPostings.set(row.term, postingRows); }
        postingRows.push({ docIndex, tf: row.tf });
      }
    }
    const rankedByMode = new Map<ScoredMode, Array<{ docIndex: number; score: number }>>();
    const modeLatency = new Map<ScoredMode, number>();
    for (const mode of scoredModes) {
      const started = performance.now();
      const ranked = mode === 'pl2'
        ? scorePl2(terms, documents.length, averageLength, lengths, collectionFrequencies, localPostings)
        : scoreAdaptiveBm25(terms, documents.length, averageLength, lengths, localPostings, models, mode);
      const rankMs = performance.now() - started;
      rankedByMode.set(mode, ranked);
      modeLatency.set(mode, rankMs);
      latency[mode].push(fetchMs + rankMs);
      const rankedIds = ranked.map(row => documents[row.docIndex]!.id);
      outcomes[mode].push({ id: qrel.id, groupId: qrel.groupId, metrics: metric(rankedIds, qrel.judgments), top10: rankedIds.slice(0, 10) });
    }
    const fusionStarted = performance.now();
    const fused = reciprocalRankFusion([rankedByMode.get('standard')!, rankedByMode.get('pl2')!], 60);
    const fusionMs = performance.now() - fusionStarted;
    const fusedIds = fused.map(row => documents[row.docIndex]!.id);
    latency['bm25-pl2-rrf'].push(fetchMs + modeLatency.get('standard')! + modeLatency.get('pl2')! + fusionMs);
    outcomes['bm25-pl2-rrf'].push({ id: qrel.id, groupId: qrel.groupId,
      metrics: metric(fusedIds, qrel.judgments), top10: fusedIds.slice(0, 10) });
    if ((queryIndex + 1) % 500 === 0 || queryIndex + 1 === queryRows.length) console.log(`evaluated ${queryIndex + 1}/${queryRows.length} dev queries`);
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
  const summary = Object.fromEntries(modes.map(mode => [mode, {
    metrics: Object.fromEntries((Object.keys(outcomes[mode][0]!.metrics) as Array<keyof Metrics>).map(key => [key, mean(outcomes[mode].map(row => row.metrics[key]))])),
    latencyMs: { p50: percentile(latency[mode], 0.5), p95: percentile(latency[mode], 0.95) },
  }])) as Record<Mode, unknown>;
  const bootstrap = (candidate: Exclude<Mode, 'standard'>, key: 'hit10' | 'ndcg10') => {
    const groupDiffs = new Map<string, number[]>();
    for (let index = 0; index < qrels.length; index++) {
      const group = outcomes.standard[index]!.groupId;
      groupDiffs.set(group, [...(groupDiffs.get(group) ?? []), outcomes[candidate][index]!.metrics[key] - outcomes.standard[index]!.metrics[key]]);
    }
    const groups = [...groupDiffs.values()];
    let seed = Number.parseInt(crypto.createHash('sha256').update(`bm25-candidate|${path.basename(datasetDir)}|${splitArg}|${candidate}|${key}`).digest('hex').slice(0, 8), 16) >>> 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
    const draws = new Array<number>(5000);
    for (let iteration = 0; iteration < draws.length; iteration++) {
      let total = 0; let count = 0;
      for (let draw = 0; draw < groups.length; draw++) {
        const group = groups[Math.floor(random() * groups.length)]!;
        total += group.reduce((sum, value) => sum + value, 0); count += group.length;
      }
      draws[iteration] = total / count;
    }
    draws.sort((a, b) => a - b);
    return { meanDifference: mean(outcomes[candidate].map((row, index) => row.metrics[key] - outcomes.standard[index]!.metrics[key])),
      clusterCount: groups.length, replicates: draws.length, ci95: [draws[124]!, draws[4_874]!] };
  };
  const pairedVsStandard = Object.fromEntries((['adaptive-k1', 'bm25-adpt', 'pl2', 'bm25-pl2-rrf'] as const).map(mode => [mode, {
    hit10: bootstrap(mode, 'hit10'), ndcg10: bootstrap(mode, 'ndcg10'),
  }]));
  const result = {
    generatedAt: new Date().toISOString(),
    dataset: { name: path.basename(datasetDir), split: splitArg, documents: documents.length, queries: qrels.length,
      positiveQrelGroups: new Set(outcomes.standard.map(row => row.groupId)).size,
      corpusSha256: corpusHash, queriesSha256: hashFile(queriesPath), qrelsSha256: hashFile(qrelsPath) },
    index: { path: indexPath, openedReadOnly: true, integrityCheck: integrity, documentIdSetVerified: true,
      provenancePath, provenanceCorpusSha256: provenance.dataset?.corpusSha256 },
    method: { tokenizer: 'existing my-search Kuromoji morphology postings; same parser terms for all modes',
      standard: 'positive-smoothed IDF BM25, k1=1.2,b=0.75',
      adaptiveK1: 'corpus information-gain fitted term-specific k1 with standard IDF',
      bm25Adpt: 'corpus information-gain fitted term-specific k1 and IG1 term weight, based on Lv & Zhai CIKM 2011; b=0.75',
      pl2: 'Xapian PL2 weighting implementation formula; c=1, unique query terms, same morphology postings and candidate set',
      bm25Pl2Rrf: 'equal reciprocal-rank fusion of standard BM25 and PL2, k=60 fixed from Cormack et al. SIGIR 2009; same candidate lists',
      noQrelsUsedForModel: true, qrelsOrThresholdsModified: false, independentFinalEvaluation: false },
    setup: { uniqueQueryTerms: allQueryTerms.size, termsWithPostingModels: models.size,
      adaptiveFitFallbackTerms: [...models.values()].filter(model => model?.fitPoints === 0).length,
      nonpositiveInformationGainTerms: [...models.values()].filter(model => (model?.informationGainIdf ?? 0) <= 0).length,
      queryAnalysisP50Ms: percentile(queryAnalysisMs, 0.5), queryAnalysisP95Ms: percentile(queryAnalysisMs, 0.95),
      adaptiveStatisticsBuildMs: modelBuildMs, processRssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
    summary, pairedVsStandard,
    perQuery: queryRows.map((row, index) => ({ id: row.id, groupId: row.groupId, query: row.text, terms: row.terms,
      standard: outcomes.standard[index], adaptiveK1: outcomes['adaptive-k1'][index], bm25Adpt: outcomes['bm25-adpt'][index], pl2: outcomes.pl2[index],
      bm25Pl2Rrf: outcomes['bm25-pl2-rrf'][index] })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, dataset: result.dataset, summary: result.summary, pairedVsStandard: result.pairedVsStandard, setup: result.setup }, null, 2));
} finally {
  database.close();
}
