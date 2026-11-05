import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { analyzeQuery } from '../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../services/discover_service.js';
import { buildStoredTokenSet } from '../../bm25_engine.js';
import { reciprocalRankFusion } from './embedding_rankers.js';

type Question = { qid: string; question: string; answer_entity: string | string[] };
type Article = { id: string; title: string; body: string };
type ModelModule = { env: { cacheDir: string; allowRemoteModels: boolean }; pipeline: (task: string, model: string, options: object) => Promise<((texts: string[], options: object) => Promise<{ data: Float32Array; dims: number[] }>)> };
const [splitArg, dataArg, databaseArg, outputArg, depthArg, modeArg, sampleGroupsArg, queryVariantArg] = process.argv.slice(2);
const split = splitArg ?? 'dev1';
if (!['dev1', 'dev2'].includes(split)) throw new Error('split must be dev1 or dev2.');
const dataDir = path.resolve(dataArg ?? 'quality/e2e/local/jaqket-public');
const databasePath = path.resolve(databaseArg ?? path.join(dataDir, 'corpus.sqlite'));
const outputPath = path.resolve(outputArg ?? path.join(dataDir, `result-${split}.json`));
const candidateDepth = Number(depthArg ?? 100);
if (!Number.isInteger(candidateDepth) || candidateDepth < 10 || candidateDepth > 1000) throw new Error('candidate depth must be between 10 and 1000.');
if (modeArg !== undefined && !['fts-only', 'sampled-e5', 'full-corpus-e5'].includes(modeArg)) throw new Error('mode must be omitted, fts-only, sampled-e5, or full-corpus-e5.');
if (['sampled-e5', 'full-corpus-e5'].includes(modeArg ?? '') && sampleGroupsArg === undefined) throw new Error(`${modeArg} mode requires a sample target-group count.`);
const queryVariant = queryVariantArg ?? 'parsed-keywords';
if (!['parsed-keywords', 'parsed-plus-raw'].includes(queryVariant)) throw new Error('query variant must be parsed-keywords or parsed-plus-raw.');
const sampleGroups = sampleGroupsArg === undefined ? undefined : Number(sampleGroupsArg);
if (sampleGroups !== undefined && (!Number.isInteger(sampleGroups) || sampleGroups < 20 || sampleGroups > 2000)) throw new Error('sample target groups must be between 20 and 2000.');
const outputRelative = path.relative(dataDir, outputPath);
if (!fs.existsSync(path.join(dataDir, 'index-provenance.json')) || fs.existsSync(outputPath)
  || outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) {
  throw new Error('A validated JAQKET index is required; output must be a new file under the ignored data directory.');
}

const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const digestFile = async (file: string) => digest(await fs.promises.readFile(file));
const norm = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? 0;
const bytes = fs.readFileSync(path.join(dataDir, `${split}_questions.json`));
const allQuestions = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Question);
if (new Set(allQuestions.map(row => row.qid)).size !== allQuestions.length || allQuestions.length < 100) throw new Error('Invalid JAQKET query set.');

// Remove target articles already judged positive in the previously explored JQaRA set.
const priorRuntimePath = path.resolve('quality/e2e/local/jqara/runtime/test-866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe.jsonl');
const priorGoldTitles = new Set<string>();
if (!fs.existsSync(priorRuntimePath)) throw new Error('Cannot audit prior JQaRA target overlap; refusing to score the JAQKET set.');
for await (const line of readline.createInterface({ input: createReadStream(priorRuntimePath), crlfDelay: Infinity })) {
  if (!line) continue;
  const row = JSON.parse(line) as { label: number; title: string };
  if (row.label > 0) priorGoldTitles.add(norm(row.title));
}
const earlierSplitTargets = new Set<string>();
if (split === 'dev2') {
  const earlierRows = fs.readFileSync(path.join(dataDir, 'dev1_questions.json'), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Question);
  for (const row of earlierRows) for (const title of Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]) earlierSplitTargets.add(norm(title));
}
const priorTargetExcluded = allQuestions.filter(row => {
  const golds = Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity];
  return golds.some(title => priorGoldTitles.has(norm(title)));
});
const remainingAfterPriorTargets = allQuestions.filter(row => !priorTargetExcluded.includes(row));
const earlierSplitTargetExcluded = remainingAfterPriorTargets.filter(row => {
  const golds = Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity];
  return golds.some(title => earlierSplitTargets.has(norm(title)));
});
const eligibleQuestions = remainingAfterPriorTargets.filter(row => !earlierSplitTargetExcluded.includes(row));
if (eligibleQuestions.length < 100) throw new Error(`Only ${eligibleQuestions.length} queries remain after prior-target overlap exclusion.`);
let questions = eligibleQuestions;
if (sampleGroups !== undefined && sampleGroups < eligibleQuestions.length) {
  const parents = eligibleQuestions.map((_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]!));
  const ownerByGold = new Map<string, number>();
  eligibleQuestions.forEach((row, index) => {
    const golds = (Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]).map(norm);
    for (const id of golds) {
      if (ownerByGold.has(id)) parents[root(index)] = root(ownerByGold.get(id)!);
      else ownerByGold.set(id, index);
    }
  });
  const grouped = new Map<number, number[]>();
  eligibleQuestions.forEach((_, index) => grouped.set(root(index), [...(grouped.get(root(index)) ?? []), index]));
  const groupDigest = (indices: number[]) => digest(`${digest(bytes)}:${indices.map(index => eligibleQuestions[index]!.qid).sort().join('|')}`);
  const selectedRoots = new Set([...grouped.entries()]
    .sort(([leftRoot, leftRows], [rightRoot, rightRows]) => groupDigest(leftRows).localeCompare(groupDigest(rightRows)) || leftRoot - rightRoot)
    .slice(0, sampleGroups)
    .map(([targetRoot]) => targetRoot));
  questions = eligibleQuestions.filter((_, index) => selectedRoots.has(root(index)));
}
const queryIds = new Set(questions.map(row => row.qid));
const targets = new Set(questions.flatMap(row => Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]).map(norm));

const indexManifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'index-provenance.json'), 'utf8')) as { corpusSha256: string; corpusBytes: number; documents: number; tokenizer: string };
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const documentCount = (database.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count;
if (documentCount !== indexManifest.documents) throw new Error('JAQKET SQLite index count does not match its provenance manifest.');
const goldRows = database.prepare(`SELECT id,title FROM articles WHERE id=?`);
for (const title of targets) if (!goldRows.get(title)) throw new Error('A JAQKET target article is missing from the indexed corpus.');
const fts = database.prepare('SELECT id FROM articles_morph_fts WHERE articles_morph_fts MATCH ? ORDER BY rank,id LIMIT ?');
const articleById = database.prepare('SELECT id,title,body FROM articles WHERE id=?');
const expression = (tokens: string[]) => [...new Set(tokens.map(token => token.trim()).filter(Boolean))].map(token => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
const prepared: Array<{ row: Question; goldIds: string[]; candidateIds: string[] }> = [];
const uniqueCandidates = new Map<string, Article>();
const parserMs: number[] = [];
const retrievalMs: number[] = [];
const errors: Array<{ qidHash: string; type: string }> = [];
const startedAt = performance.now();
for (const [queryIndex, row] of questions.entries()) {
  const goldIds = (Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]).map(norm);
  try {
    const parsedStarted = performance.now();
    const words = await purposeWords(row.question);
    const parsed = analyzeQuery(row.question, words.length ? words : row.question.split(/\s+/u).filter(Boolean), term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const searchText = parsed.keywords.map(item => item.term).join(' ')
      + (queryVariant === 'parsed-plus-raw' ? ` ${row.question}` : '');
    const tokenSet = await buildStoredTokenSet(searchText);
    const match = expression(tokenSet.morphologicalTokens);
    parserMs.push(performance.now() - parsedStarted);
    const retrieveStarted = performance.now();
    const candidateIds = match ? (fts.all(match, candidateDepth) as Array<{ id: string }>).map(result => result.id) : [];
    retrievalMs.push(performance.now() - retrieveStarted);
    for (const id of candidateIds) {
      const article = articleById.get(id) as Article | undefined;
      if (!article) throw new Error('FTS candidate is missing its article row.');
      uniqueCandidates.set(id, article);
    }
    prepared.push({ row, goldIds, candidateIds });
  } catch (error) {
    errors.push({ qidHash: digest(row.qid), type: error instanceof Error ? error.name : 'Error' });
    prepared.push({ row, goldIds, candidateIds: [] });
  }
  if ((queryIndex + 1) % 50 === 0 || queryIndex + 1 === questions.length) {
    console.log(JSON.stringify({ phase: 'candidate-retrieval', completed: queryIndex + 1, total: questions.length, uniqueCandidates: uniqueCandidates.size, errors: errors.length }));
  }
}
database.close();

if (modeArg === 'fts-only') {
  const ftsHits = prepared.map(item => Number(item.candidateIds.slice(0, 10).some(id => item.goldIds.includes(id))));
  const candidateHits = prepared.map(item => Number(item.candidateIds.some(id => item.goldIds.includes(id))));
  const parents = prepared.map((_, i) => i);
  const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]!));
  const ownerByGold = new Map<string, number>();
  prepared.forEach((item, index) => item.goldIds.forEach(id => {
    if (ownerByGold.has(id)) parents[root(index)] = root(ownerByGold.get(id)!);
    else ownerByGold.set(id, index);
  }));
  const targetClusters = new Map<number, number[]>();
  prepared.forEach((_, index) => targetClusters.set(root(index), [...(targetClusters.get(root(index)) ?? []), index]));
  let seed = Number.parseInt(digest(bytes).slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const samples = new Array<number>(10000);
  const clusters = [...targetClusters.values()];
  for (let iteration = 0; iteration < samples.length; iteration++) {
    let sum = 0, count = 0;
    for (let i = 0; i < clusters.length; i++) for (const index of clusters[Math.floor(random() * clusters.length)]!) { sum += ftsHits[index]!; count++; }
    samples[iteration] = sum / Math.max(1, count);
  }
  samples.sort((a, b) => a - b);
  const results = {
    hit10: ftsHits.reduce((sum, hit) => sum + hit, 0) / Math.max(1, ftsHits.length),
    successes: ftsHits.reduce((sum, hit) => sum + hit, 0),
    clusterBootstrap95: { percentile95: [samples[249], samples[9749]], targetGroups: clusters.length, draws: samples.length },
    p50Ms: percentile(prepared.map((_, i) => (parserMs[i] ?? 0) + (retrievalMs[i] ?? 0)), .5),
    p95Ms: percentile(prepared.map((_, i) => (parserMs[i] ?? 0) + (retrievalMs[i] ?? 0)), .95),
  };
  const result = {
    purpose: 'Exploratory Japanese public quiz QA retrieval proxy. Not evidence of general saved-article refinding.',
    dataset: {
      name: `JAQKET-${split}-public-dev`, split, queries: allQuestions.length,
      queriesAfterPriorJQaRATargetExclusion: remainingAfterPriorTargets.length, eligibleQueryCount: eligibleQuestions.length,
      evaluatedQueryCount: questions.length, sampledTargetGroupLimit: sampleGroups ?? null,
      uniqueTargetGroups: clusters.length, excludedPriorJQaRATargetQueries: priorTargetExcluded.length,
      excludedEarlierDevelopmentTargetQueries: earlierSplitTargetExcluded.length,
      querySha256: digest(bytes), corpusSha256: indexManifest.corpusSha256, corpusDocuments: documentCount,
      queryIdsSha256: digest([...queryIds].sort().join('\n')),
    },
    implementation: {
      applicationQueryAnalysis: 'my-search query parsing + morphology-tokenized SQLite FTS5 BM25', candidateDepth,
      queryVariant,
      databaseReadOnly: true, productionDatabaseChanged: false, rawQueriesOrArticleTitlesInOutput: false,
    },
    outcomes: {
      apiOrIndexErrors: errors.length,
      errorTypes: Object.fromEntries([...new Set(errors.map(error => error.type))].map(type => [type, errors.filter(error => error.type === type).length])),
      candidateCoverage: candidateHits.reduce((sum, hit) => sum + hit, 0) / Math.max(1, candidateHits.length),
      candidateMisses: candidateHits.filter(hit => hit === 0).length,
      fts5Bm25: results,
    },
    phases: { queryAnalysisP95Ms: percentile(parserMs, .95), candidateRetrievalP95Ms: percentile(retrievalMs, .95), elapsedMs: performance.now() - startedAt },
    sourceFiles: {
      questionSha256: digest(bytes), indexManifestSha256: digest(fs.readFileSync(path.join(dataDir, 'index-provenance.json'))),
      evaluationScriptSha256: await digestFile(path.resolve('scripts/bench/benchmark_jaqket_retrieval.ts')),
      packageLockSha256: await digestFile(path.resolve('package-lock.json')),
      queryAnalysisSha256: await digestFile(path.resolve('services/query_analysis.ts')),
      searchTokenizerSha256: await digestFile(path.resolve('bm25_engine.ts')),
      queryPurposeSha256: await digestFile(path.resolve('services/discover_service.ts')),
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ outputPath, dataset: result.dataset, outcomes: result.outcomes, phases: result.phases }, null, 2));
  process.exit(0);
}

// Full-corpus mode measures semantic retrieval over every document, not just
// the lexical candidate pool. The database remains an isolated read-only copy.
const fullCorpusE5 = modeArg === 'full-corpus-e5';
if (fullCorpusE5) {
  const fullDatabase = new Database(databasePath, { readonly: true, fileMustExist: true });
  const allArticles = fullDatabase.prepare('SELECT id,title,body FROM articles ORDER BY id').all() as Article[];
  for (const article of allArticles) uniqueCandidates.set(article.id, article);
  fullDatabase.close();
}

const runtimeRoot = path.resolve('quality/e2e/local/embedding-runtime');
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'node_modules/@huggingface/transformers/package.json'), 'utf8')) as { version: string };
const { env, pipeline: createPipeline } = createRequire(path.join(runtimeRoot, 'runner.cjs'))('@huggingface/transformers') as ModelModule;
env.cacheDir = path.resolve('quality/e2e/local/embedding-cache');
env.allowRemoteModels = false;
const modelId = 'Xenova/multilingual-e5-small';
const modelPath = path.join(env.cacheDir, modelId, 'onnx', 'model_quantized.onnx');
for (const file of [modelPath, path.join(env.cacheDir, modelId, 'tokenizer.json'), path.join(env.cacheDir, modelId, 'tokenizer_config.json')]) if (!fs.existsSync(file)) throw new Error(`Offline model asset is missing: ${file}`);
const modelSha256 = await new Promise<string>((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(modelPath).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const extractor = await createPipeline('feature-extraction', modelId, { dtype: 'q8' });
const dimension = 384;
const vectors = new Map<string, Float32Array>();
const candidateIds = [...uniqueCandidates.keys()].sort((a, b) => a.localeCompare(b));
const vectorCacheRoot = path.join(dataDir, 'e5-full-corpus-title512-v1');
const vectorCacheManifestPath = path.join(vectorCacheRoot, 'manifest.json');
const vectorCacheDataPath = path.join(vectorCacheRoot, 'vectors.f32');
const documentIdsSha256 = digest(candidateIds.join('\n'));
let vectorCacheReused = false;
let vectorCacheReadMs = 0;
let candidateEmbeddingMs = 0;
if (fullCorpusE5 && fs.existsSync(vectorCacheRoot)) {
  const cacheStarted = performance.now();
  const cacheManifest = JSON.parse(await fs.promises.readFile(vectorCacheManifestPath, 'utf8')) as {
    corpusSha256: string; indexManifestSha256: string; modelSha256: string; modelId: string;
    transformersVersion: string; dimensions: number; documents: number; documentIdsSha256: string;
    passageText: string; vectorSha256: string; vectorBytes: number;
  };
  const expectedIndexManifestSha256 = digest(fs.readFileSync(path.join(dataDir, 'index-provenance.json')));
  const expectedVectorBytes = candidateIds.length * dimension * Float32Array.BYTES_PER_ELEMENT;
  if (cacheManifest.corpusSha256 !== indexManifest.corpusSha256
    || cacheManifest.indexManifestSha256 !== expectedIndexManifestSha256
    || cacheManifest.modelSha256 !== modelSha256
    || cacheManifest.modelId !== modelId
    || cacheManifest.transformersVersion !== runtimePackage.version
    || cacheManifest.dimensions !== dimension
    || cacheManifest.documents !== candidateIds.length
    || cacheManifest.documentIdsSha256 !== documentIdsSha256
    || cacheManifest.passageText !== 'title + first 512 body characters'
    || cacheManifest.vectorBytes !== expectedVectorBytes) {
    throw new Error('The local full-corpus E5 vector cache does not match the current corpus, model, tokenizer runtime, or passage settings.');
  }
  const vectorBytes = await fs.promises.readFile(vectorCacheDataPath);
  if (vectorBytes.byteLength !== expectedVectorBytes || digest(vectorBytes) !== cacheManifest.vectorSha256) {
    throw new Error('The local full-corpus E5 vector cache failed its size or SHA-256 check.');
  }
  for (let i = 0; i < candidateIds.length; i++) {
    const byteOffset = i * dimension * Float32Array.BYTES_PER_ELEMENT;
    vectors.set(candidateIds[i]!, new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset + byteOffset, dimension));
  }
  vectorCacheReused = true;
  vectorCacheReadMs = performance.now() - cacheStarted;
} else {
  const embeddingStarted = performance.now();
  const stagingRoot = fullCorpusE5 ? path.join(dataDir, `e5-full-corpus-title512-v1.building-${process.pid}-${Date.now()}`) : null;
  const stagingDataPath = stagingRoot ? path.join(stagingRoot, 'vectors.f32') : null;
  const stagingManifestPath = stagingRoot ? path.join(stagingRoot, 'manifest.json') : null;
  if (stagingRoot) await fs.promises.mkdir(stagingRoot);
  const vectorFile = stagingDataPath ? await fs.promises.open(stagingDataPath, 'wx') : null;
  let vectorBytesWritten = 0;
  try {
    for (let offset = 0; offset < candidateIds.length; offset += 32) {
      const ids = candidateIds.slice(offset, offset + 32);
      const texts = ids.map(id => {
        const article = uniqueCandidates.get(id)!;
        const bodyLimit = fullCorpusE5 ? 512 : 2048;
        return `passage: ${`${article.title} ${article.body.slice(0, bodyLimit)}`.normalize('NFKC')}`;
      });
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      if (output.dims.at(-1) !== dimension || output.data.length !== ids.length * dimension) throw new Error('Unexpected E5 candidate-vector shape.');
      ids.forEach((id, i) => vectors.set(id, output.data.slice(i * dimension, (i + 1) * dimension)));
      if (vectorFile) {
        const chunk = Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength);
        let chunkWritten = 0;
        while (chunkWritten < chunk.byteLength) {
          const written = await vectorFile.write(chunk, chunkWritten, chunk.byteLength - chunkWritten, vectorBytesWritten + chunkWritten);
          if (written.bytesWritten === 0) throw new Error('Incomplete write to the local E5 vector cache.');
          chunkWritten += written.bytesWritten;
        }
        vectorBytesWritten += chunkWritten;
      }
      if ((offset + ids.length) % 256 < 32 || offset + ids.length === candidateIds.length) {
        console.log(JSON.stringify({ phase: 'candidate-embeddings', completed: offset + ids.length, total: candidateIds.length, rssBytes: process.memoryUsage().rss }));
      }
    }
    if (vectorFile) {
      await vectorFile.close();
      const vectorSha256 = await digestFile(stagingDataPath!);
      const cacheManifest = {
        corpusSha256: indexManifest.corpusSha256,
        indexManifestSha256: digest(fs.readFileSync(path.join(dataDir, 'index-provenance.json'))),
        modelSha256, modelId, transformersVersion: runtimePackage.version,
        dimensions: dimension, documents: candidateIds.length, documentIdsSha256,
        passageText: 'title + first 512 body characters', vectorBytes: vectorBytesWritten, vectorSha256,
      };
      await fs.promises.writeFile(stagingManifestPath!, `${JSON.stringify(cacheManifest, null, 2)}\n`, { flag: 'wx' });
      await fs.promises.rename(stagingRoot!, vectorCacheRoot);
    }
  } catch (error) {
    await vectorFile?.close().catch(() => undefined);
    throw error;
  }
  candidateEmbeddingMs = performance.now() - embeddingStarted;
}

const methods = ['fts5-bm25', 'e5-rerank', 'rrf-bm25-e5'] as const;
type Method = typeof methods[number];
const hits: Record<Method, number[]> = { 'fts5-bm25': [], 'e5-rerank': [], 'rrf-bm25-e5': [] };
const latencies: Record<Method, number[]> = { 'fts5-bm25': [], 'e5-rerank': [], 'rrf-bm25-e5': [] };
const queryEmbeddingMs: number[] = [];
const semanticSearchMs: number[] = [];
const candidateHits: number[] = [];
const semanticCandidateHits: number[] = [];
const fusedCandidateHits: number[] = [];
const rerankMisses: Record<'e5-rerank' | 'rrf-bm25-e5', number> = { 'e5-rerank': 0, 'rrf-bm25-e5': 0 };
for (const [index, item] of prepared.entries()) {
  let queryVector: Float32Array<ArrayBufferLike> = new Float32Array(dimension);
  let embeddingMs = 0;
  let embeddingFailed = false;
  try {
    const embeddedAt = performance.now();
    const output = await extractor([`query: ${item.row.question}`.normalize('NFKC')], { pooling: 'mean', normalize: true });
    if (output.data.length !== dimension) throw new Error('Unexpected E5 query-vector shape.');
    queryVector = output.data;
    embeddingMs = performance.now() - embeddedAt;
    queryEmbeddingMs.push(embeddingMs);
  } catch {
    embeddingFailed = true;
    errors.push({ qidHash: digest(item.row.qid), type: 'QueryEmbeddingError' });
  }
  const semanticStarted = performance.now();
  const e5CandidateIds = fullCorpusE5 ? [...vectors.keys()] : item.candidateIds;
  const e5Ids = e5CandidateIds.map(id => {
    const vector = vectors.get(id)!;
    let score = 0;
    for (let axis = 0; axis < dimension; axis++) score += vector[axis]! * queryVector[axis]!;
    return { id, score };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, candidateDepth).map(result => result.id);
  const semanticMs = performance.now() - semanticStarted;
  semanticSearchMs.push(semanticMs);
  const fusedIds = reciprocalRankFusion([item.candidateIds, e5Ids], 60, candidateDepth);
  const ranked: Record<Method, string[]> = { 'fts5-bm25': item.candidateIds, 'e5-rerank': e5Ids, 'rrf-bm25-e5': fusedIds };
  const candidateHit = Number(item.candidateIds.some(id => item.goldIds.includes(id)));
  candidateHits.push(candidateHit);
  semanticCandidateHits.push(Number(e5Ids.some(id => item.goldIds.includes(id))));
  fusedCandidateHits.push(Number(fusedIds.some(id => item.goldIds.includes(id))));
  if (candidateHit && !e5Ids.slice(0, 10).some(id => item.goldIds.includes(id))) rerankMisses['e5-rerank']++;
  if (candidateHit && !fusedIds.slice(0, 10).some(id => item.goldIds.includes(id))) rerankMisses['rrf-bm25-e5']++;
  for (const method of methods) {
    const rank = ranked[method].findIndex(id => item.goldIds.includes(id));
    const failure = errors.some(error => error.qidHash === digest(item.row.qid) && error.type !== 'QueryEmbeddingError');
    const unavailable = failure || (method !== 'fts5-bm25' && embeddingFailed);
    hits[method].push(Number(!unavailable && rank >= 0 && rank < 10));
    const elapsed = (parserMs[index] ?? 0) + (retrievalMs[index] ?? 0) + (method === 'fts5-bm25' ? 0 : embeddingMs + semanticMs);
    latencies[method].push(elapsed);
  }
  if ((index + 1) % 100 === 0 || index + 1 === prepared.length) console.log(JSON.stringify({ phase: 'rank', completed: index + 1, total: prepared.length, errors: errors.length }));
}

const mean = (rows: number[]) => rows.reduce((sum, value) => sum + value, 0) / Math.max(rows.length, 1);
let seed = Number.parseInt(digest(bytes).slice(0, 8), 16) >>> 0;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
const parents = prepared.map((_, i) => i);
const root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]!));
const ownerByGold = new Map<string, number>();
prepared.forEach((item, index) => item.goldIds.forEach(id => {
  if (ownerByGold.has(id)) parents[root(index)] = root(ownerByGold.get(id)!);
  else ownerByGold.set(id, index);
}));
const targetClusters = new Map<number, number[]>();
prepared.forEach((_, index) => targetClusters.set(root(index), [...(targetClusters.get(root(index)) ?? []), index]));
const clusterBootstrap = (values: number[], draws = 10000) => {
  const clusters = [...targetClusters.values()];
  const samples = new Array<number>(draws);
  for (let iteration = 0; iteration < draws; iteration++) {
    let sum = 0, count = 0;
    for (let i = 0; i < clusters.length; i++) for (const index of clusters[Math.floor(random() * clusters.length)]!) { sum += values[index]!; count++; }
    samples[iteration] = sum / Math.max(1, count);
  }
  samples.sort((a, b) => a - b);
  return { percentile95: [samples[249], samples[9749]], targetGroups: clusters.length, draws };
};
const results = Object.fromEntries(methods.map(method => [method, {
  hit10: mean(hits[method]), successes: hits[method].reduce((a, b) => a + b, 0),
  clusterBootstrap95: clusterBootstrap(hits[method]),
  p50Ms: percentile(latencies[method], .5), p95Ms: percentile(latencies[method], .95),
}]));
const result = {
  purpose: 'Exploratory external Japanese article retrieval proxy on public human-written quiz questions. Not evidence of general saved-article refinding: task is quiz QA and split is public.',
  dataset: {
    name: `JAQKET-${split}-public-dev`, split, queries: allQuestions.length,
    queriesAfterPriorJQaRATargetExclusion: remainingAfterPriorTargets.length, eligibleQueryCount: eligibleQuestions.length,
    evaluatedQueryCount: questions.length, sampledTargetGroupLimit: sampleGroups ?? null,
    uniqueTargetGroups: targetClusters.size, excludedPriorJQaRATargetQueries: priorTargetExcluded.length,
    excludedEarlierDevelopmentTargetQueries: earlierSplitTargetExcluded.length,
    querySha256: digest(bytes), corpusSha256: indexManifest.corpusSha256, corpusDocuments: documentCount,
    queryIdsSha256: digest([...queryIds].sort().join('\n')),
  },
  implementation: {
    applicationQueryAnalysis: 'my-search query parsing + morphology-tokenized SQLite FTS5 BM25', candidateDepth,
    queryVariant,
    reranking: fullCorpusE5
      ? 'Xenova/multilingual-e5-small q8; exact full-corpus cosine; equal RRF k=60 over FTS and E5 top candidateDepth; passage input uses title plus first 512 body characters'
      : 'Xenova/multilingual-e5-small q8; equal RRF k=60; E5 and fused rankings are restricted to FTS candidates; passage input uses title plus first 2048 body characters before the model tokenizer 512-token truncation',
    modelSha256, transformersVersion: runtimePackage.version,
    uniqueCandidatesEmbedded: vectorCacheReused ? 0 : candidateIds.length,
    cachedVectorDocuments: vectorCacheReused ? candidateIds.length : 0,
    vectorCacheReused, vectorCacheReadMs,
    candidateEmbeddingMs, passageText: fullCorpusE5 ? 'title + first 512 body characters' : 'title + first 2048 body characters', semanticRetrieval: fullCorpusE5 ? 'exact cosine over every corpus document' : 'rerank lexical candidate pool', databaseReadOnly: true, productionDatabaseChanged: false, rawQueriesOrArticleTitlesInOutput: false,
  },
  outcomes: {
    apiOrIndexErrors: errors.length, errorTypes: Object.fromEntries([...new Set(errors.map(error => error.type))].map(type => [type, errors.filter(error => error.type === type).length])),
    candidateCoverage: mean(candidateHits), candidateMisses: candidateHits.filter(hit => hit === 0).length,
    semanticCandidateCoverage: mean(semanticCandidateHits), semanticCandidateMisses: semanticCandidateHits.filter(hit => hit === 0).length,
    fusedCandidateCoverage: mean(fusedCandidateHits), fusedCandidateMisses: fusedCandidateHits.filter(hit => hit === 0).length,
    rerankMissesAfterCandidateHit: rerankMisses,
    results,
  },
  phases: { queryAnalysisP95Ms: percentile(parserMs, .95), candidateRetrievalP95Ms: percentile(retrievalMs, .95), candidateEmbeddingMs, vectorCacheReadMs, queryEmbeddingP95Ms: percentile(queryEmbeddingMs, .95), semanticSearchP95Ms: percentile(semanticSearchMs, .95), elapsedMs: performance.now() - startedAt },
  sourceFiles: {
    questionSha256: digest(bytes), indexManifestSha256: digest(fs.readFileSync(path.join(dataDir, 'index-provenance.json'))),
    evaluationScriptSha256: await digestFile(path.resolve('scripts/bench/benchmark_jaqket_retrieval.ts')),
    packageLockSha256: await digestFile(path.resolve('package-lock.json')),
    queryAnalysisSha256: await digestFile(path.resolve('services/query_analysis.ts')),
    searchTokenizerSha256: await digestFile(path.resolve('bm25_engine.ts')),
    queryPurposeSha256: await digestFile(path.resolve('services/discover_service.ts')),
    fusionImplementationSha256: await digestFile(path.resolve('scripts/bench/embedding_rankers.ts')),
  },
};
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, dataset: result.dataset, outcomes: result.outcomes, phases: result.phases }, null, 2));
