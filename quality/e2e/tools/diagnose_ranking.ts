import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { buildStoredTokenSet, MODES, runPipeline, tokenizeMorphological, tokenizeQuery, type Article } from '../../../bm25_engine.js';
import { analyzeQuery } from '../../../services/query_analysis.js';
import { purposeTermWeight, purposeWords } from '../../../services/discover_service.js';

type DatasetQuery = { id: string; query: string; gold_ids: string[]; group_id: string };
type DatasetDocument = { id: string; title: string; body: string };
type TokenRow = {
  id: string;
  title: string;
  body: string;
  tokens_json: string | null;
  doc_length: number | null;
  morphological_tokens_json: string | null;
  ngram_tokens_json: string | null;
  morphological_doc_length: number | null;
  ngram_doc_length: number | null;
};
const ENGLISH_STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself nor of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours`.split(' '));
const BOOK_DOMAIN_FILLER = new Set(['tomt', 'book', 'books', 'novel', 'novels']);

function readJsonl<T>(file: string): T[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

function bm25Rank(
  documents: Article[],
  queryTokens: string[],
  documentFrequency: Map<string, number>,
  averageLength: number,
  k1 = 1.2,
  b = 0.75,
): Array<{ id: string; score: number }> {
  const n = documents.length;
  const uniqueQuery = [...new Set(queryTokens)];
  const scores: Array<{ id: string; score: number }> = [];
  for (const document of documents) {
    const tokens = document.morphologicalTokens ?? [];
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of uniqueQuery) {
      const frequency = tf.get(term) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
      score += idf * (frequency * (k1 + 1)) /
        (frequency + k1 * (1 - b + b * (tokens.length / Math.max(averageLength, 1))));
    }
    if (score > 0) scores.push({ id: document.id, score });
  }
  return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

async function main() {
  const [datasetDir, stage = 'development', outputPath, groupLimitText, seed = 'phase2-development-diagnostic-v1', profile = 'current'] = process.argv.slice(2);
  if (!datasetDir || !outputPath || !['development', 'validation'].includes(stage)) {
    throw new Error('Usage: node --import tsx quality/e2e/tools/diagnose_ranking.ts <dataset-dir> <development|validation> <output.json> [group-limit] [seed] [current|english-clean|parser-clean] [manifest.json] [mode-id] [group-offset]');
  }
  if (!['current', 'english-clean', 'parser-clean'].includes(profile)) throw new Error(`Unknown diagnostic profile: ${profile}`);
  const optionArgs = process.argv.slice(2);
  const manifestArg = process.argv[8];
  const manifestPath = manifestArg && !manifestArg.startsWith('--') ? manifestArg : undefined;
  const modeId = optionArgs.find(value => value.startsWith('--mode-id='))?.slice('--mode-id='.length) ?? process.argv[9] ?? 'impl';
  const groupOffset = Number.parseInt(optionArgs.find(value => value.startsWith('--group-offset='))?.slice('--group-offset='.length) ?? process.argv[10] ?? '0', 10);
  const tokenDatabasePath = optionArgs.find(value => value.startsWith('--database='))?.slice('--database='.length);
  const selectedMode = MODES[modeId as keyof typeof MODES];
  if (!selectedMode) throw new Error(`Unknown ranking mode: ${modeId}`);
  if (!Number.isInteger(groupOffset) || groupOffset < 0) throw new Error('Group offset must be a non-negative integer');
  const sourceDocs = readJsonl<DatasetDocument>(path.join(datasetDir, 'documents.jsonl'));
  let queries = readJsonl<DatasetQuery>(path.join(datasetDir, `${stage}.jsonl`));
  let selection: Record<string, unknown> | null = null;
  const groupLimit = Number.parseInt(groupLimitText ?? '0', 10);
  if (manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { stage: string; group_ids: string[]; query_ids: string[] };
    if (manifest.stage !== stage) throw new Error('Sample manifest stage does not match requested stage');
    const selected = new Set(manifest.group_ids);
    queries = queries.filter(query => selected.has(query.group_id));
    if (queries.length !== manifest.query_ids.length || queries.some(query => !manifest.query_ids.includes(query.id))) {
      throw new Error('Sample manifest query/group IDs do not match the source data');
    }
  }
  if (groupLimit > 0) {
    const groups = [...new Set(queries.map(query => query.group_id))];
    const orderedGroups = groupOffset > 0
      ? groups.sort((a, b) => createHash('sha256').update(a).digest('hex').localeCompare(createHash('sha256').update(b).digest('hex')))
      : groups.sort((a, b) => createHash('sha256').update(`${seed}|${a}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}|${b}`).digest('hex')));
    const selectedGroups = orderedGroups.slice(groupOffset, groupOffset + groupLimit);
    if (selectedGroups.length !== groupLimit) throw new Error(`Requested ${groupLimit} groups at offset ${groupOffset}, found ${selectedGroups.length}`);
    const selected = new Set(selectedGroups);
    queries = queries.filter(query => selected.has(query.group_id));
    if (groupOffset > 0) queries = selectedGroups.map(group => queries.filter(query => query.group_id === group)
      .sort((a, b) => createHash('sha256').update(`${group}\0${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${group}\0${b.id}`).digest('hex')))[0]!);
    selection = { method: groupOffset > 0 ? 'SHA-256(group_id) ascending, fixed offset, then one query per group by SHA-256(group_id + NUL + query_id)' : `SHA-256(${seed}|group_id) ascending`, offset: groupOffset, groups: selectedGroups.length,
      groupIdsSha256: createHash('sha256').update([...selectedGroups].sort().join('\n')).digest('hex'),
      queryIdsSha256: createHash('sha256').update(queries.map(query => `${query.group_id}\t${query.id}`).sort().join('\n')).digest('hex') };
  }

  const tokenRowsById = new Map<string, TokenRow>();
  if (tokenDatabasePath) {
    const db = new Database(path.resolve(tokenDatabasePath), { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT id, title, body, tokens_json, doc_length, morphological_tokens_json, ngram_tokens_json, morphological_doc_length, ngram_doc_length FROM cards WHERE archived = 0`).all() as TokenRow[];
      for (const row of rows) tokenRowsById.set(row.id.replace(/^benchmark-/, ''), row);
    } finally {
      db.close();
    }
    if (tokenRowsById.size !== sourceDocs.length || sourceDocs.some(source => !tokenRowsById.has(source.id))) {
      throw new Error(`Cached-token DB does not match the dataset: source=${sourceDocs.length}, cached=${tokenRowsById.size}`);
    }
    const textMismatch = sourceDocs.find(source => {
      const cached = tokenRowsById.get(source.id)!;
      return cached.title !== source.title || cached.body !== source.body;
    });
    if (textMismatch) throw new Error(`Cached-token DB source text differs for ${textMismatch.id}`);
  }

  const documents: Article[] = [];
  for (const source of sourceDocs) {
    const cached = tokenRowsById.get(source.id);
    const stored = cached ? {
      morphologicalTokens: JSON.parse(cached.morphological_tokens_json ?? '[]') as string[],
      ngramTokens: JSON.parse(cached.ngram_tokens_json ?? cached.tokens_json ?? '[]') as string[],
      morphologicalDocLength: cached.morphological_doc_length ?? 0,
      ngramDocLength: cached.ngram_doc_length ?? cached.doc_length ?? 0,
    } : await buildStoredTokenSet(`${source.title} ${source.body}`);
    if (!stored.morphologicalTokens.length || !stored.ngramTokens.length) {
      throw new Error(`Missing cached tokens for ${source.id}`);
    }
    documents.push({
      id: source.id,
      title: source.title,
      body: source.body,
      publishedAt: new Date('2020-01-01T00:00:00.000Z'),
      sourceAuthority: 0.8,
      url: '',
      source: 'Reddit-TOMT',
      tokens: stored.ngramTokens,
      docLength: stored.ngramDocLength,
      ...stored,
    });
  }

  const mode = selectedMode;
  const df = new Map<string, number>();
  let totalMorphLength = 0;
  for (const document of documents) {
    const unique = new Set(document.morphologicalTokens ?? []);
    totalMorphLength += document.morphologicalDocLength ?? 0;
    for (const token of unique) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const averageMorphLength = totalMorphLength / Math.max(documents.length, 1);
  const documentById = new Map(documents.map(document => [document.id, document]));
  const results = [];

  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const start = performance.now();
    const parserInput = profile === 'parser-clean'
      ? query.query.replace(/^\s*(?:\[[^\]]{1,50}\]\s*)+/u, '')
      : query.query;
    const words = await purposeWords(parserInput);
    const analysis = analyzeQuery(query.query, words, term => purposeTermWeight(term) === 3 ? 1.5 : 1);
    const selectedKeywords = profile === 'current'
      ? analysis.keywords
      : analysis.keywords.filter(keyword => !ENGLISH_STOPWORDS.has(keyword.term.toLowerCase()) &&
          !(profile === 'english-clean' && BOOK_DOMAIN_FILLER.has(keyword.term.toLowerCase())));
    const keywords = selectedKeywords.map(keyword => ({ ...keyword, synonyms: [] }));
    const expandedQuery = await tokenizeQuery(keywords.map(keyword => keyword.term).join(' '));
    const current = await runPipeline(documents, { ...mode, keywords }, 'diagnostic-current', {
      dedupThreshold: 1,
      archiveScoreThreshold: 0,
      resultLimit: 1000,
    });
    const standard = bm25Rank(documents, keywords.map(keyword => keyword.term), df, averageMorphLength);
    const standardMatchedParameters = bm25Rank(documents, keywords.map(keyword => keyword.term), df, averageMorphLength, mode.k1, mode.b);
    const rrfScores = new Map<string, number>();
    current.active.forEach((item, rank) => rrfScores.set(item.article.id, (rrfScores.get(item.article.id) ?? 0) + 1 / (60 + rank + 1)));
    standard.slice(0, 1000).forEach((item, rank) => rrfScores.set(item.id, (rrfScores.get(item.id) ?? 0) + 1 / (60 + rank + 1)));
    const rrf = [...rrfScores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const expected = query.gold_ids;
    const currentRank = current.active.findIndex(item => expected.includes(item.article.id)) + 1 || null;
    const standardRank = standard.findIndex(item => expected.includes(item.id)) + 1 || null;
    const matchedStandardRank = standardMatchedParameters.findIndex(item => expected.includes(item.id)) + 1 || null;
    const rrfRank = rrf.findIndex(([id]) => expected.includes(id)) + 1 || null;
    const target = expected.map(id => documentById.get(id)).find(Boolean);
    const targetMorph = new Set(target?.morphologicalTokens ?? []);
    const targetNgram = new Set(target?.ngramTokens ?? []);
    const targetMorphMatches = await Promise.all(keywords.map(async keyword => {
      const terms = await tokenizeMorphological(keyword.term);
      return { term: keyword.term, present: terms.some(term => targetMorph.has(term)), tokens: terms };
    }));
    const targetNgramMatches = await Promise.all(keywords.map(async keyword => {
      const terms = await tokenizeQuery(keyword.term);
      return { term: keyword.term, present: terms.some(term => targetNgram.has(term)), tokens: terms };
    }));
    const currentTarget = current.active.find(item => expected.includes(item.article.id));
    const standardTop10 = standard.slice(0, 10).map(item => item.id);
    const currentTop10 = current.active.slice(0, 10).map(item => item.article.id);
    results.push({
      qid: query.id,
      groupId: query.group_id,
      query: query.query,
      expected,
      parser: {
        profile,
        inputAfterMetadataStrip: parserInput,
        inputTokenCount: words.length,
        outputBeforeFilter: analysis.keywords,
        effectiveOutput: selectedKeywords,
        specificTerms: analysis.specificTerms,
        genericTerms: analysis.genericTerms,
        intent: analysis.intent,
      },
      targetDocument: target ? { id: target.id, title: target.title, body: target.body } : null,
      targetInformation: {
        parserKeywordCount: keywords.length,
        morphologicalMatchedCount: targetMorphMatches.filter(item => item.present).length,
        morphologicalMatches: targetMorphMatches,
        ngramMatchedCount: targetNgramMatches.filter(item => item.present).length,
        ngramMatches: targetNgramMatches,
        expandedQueryTokenCount: expandedQuery.length,
      },
      current: {
        rankTop500: currentRank && currentRank <= 500 ? currentRank : null,
        rankTop10: currentRank && currentRank <= 10 ? currentRank : null,
        rankTop100: currentRank && currentRank <= 100 ? currentRank : null,
        rankTop1000: currentRank ?? (current.stats.activeCount <= 1000 ? 'candidate_not_generated' : 'not_observable_after_internal_limit'),
        candidateCount: current.stats.activeCount,
        score: currentTarget?.score ?? null,
        breakdown: currentTarget?.breakdown ?? null,
        top10: currentTop10,
        top1000: current.active.map(item => item.article.id),
      },
      standardBm25Morphology: {
        rankTop500: standardRank,
        rankTop10: standardRank && standardRank <= 10 ? standardRank : null,
        rankTop100: standardRank && standardRank <= 100 ? standardRank : null,
        rankTop1000: standardRank && standardRank <= 1000 ? standardRank : standardRank ? 'beyond_1000' : 'candidate_not_generated',
        candidateCount: standard.length,
        targetScore: standardRank ? standard[standardRank - 1]?.score ?? null : null,
        top10: standardTop10,
        top1000: standard.slice(0, 1000).map(item => item.id),
      },
      standardBm25MatchedParameters: {
        k1: mode.k1,
        b: mode.b,
        rankTop10: matchedStandardRank && matchedStandardRank <= 10 ? matchedStandardRank : null,
        rankTop100: matchedStandardRank && matchedStandardRank <= 100 ? matchedStandardRank : null,
        candidateCount: standardMatchedParameters.length,
        top10: standardMatchedParameters.slice(0, 10).map(item => item.id),
      },
      rrf60: {
        rankTop1000: rrfRank && rrfRank <= 1000 ? rrfRank : rrfRank ? 'beyond_1000' : 'candidate_not_generated',
        rankTop10: rrfRank && rrfRank <= 10 ? rrfRank : null,
        top10: rrf.slice(0, 10).map(([id]) => id),
      },
      latencyMs: Number((performance.now() - start).toFixed(2)),
    });
    if ((index + 1) % 100 === 0) console.log(`diagnosed ${index + 1}/${queries.length}`);
  }

  const report = {
    dataset: path.basename(path.resolve(datasetDir)),
    stage,
    profile,
    modeId,
    groupLimit: groupLimit || null,
    groupOffset: groupLimit ? groupOffset : null,
    selection,
    sampleSeed: groupLimit ? seed : null,
    documentCount: documents.length,
    queryCount: queries.length,
    comparison: 'application runPipeline vs independent morphology BM25 at k1=1.2,b=0.75 and at matched mode k1/b; shared query parser and document tokenization',
    tokenSource: tokenDatabasePath ? 'read-only persisted token cache from isolated SQLite DB' : 'tokenized from source documents at runtime',
    tokenDatabase: tokenDatabasePath ? path.resolve(tokenDatabasePath) : null,
    sampleManifest: manifestPath ? path.resolve(manifestPath) : null,
    caveat: 'Direct engine diagnosis; not a browser/API E2E. runPipeline is the production ranking implementation. Standard BM25 comparison shares the production parser and morphology tokenization.',
    results,
  };
  const absoluteOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const failed = results.filter(item => !item.current.rankTop10).length;
  const summary = {
    stage,
    queryCount: results.length,
    currentHitAt1: results.filter(item => item.current.rankTop10 === 1).length,
    currentHitAt10: results.filter(item => item.current.rankTop10).length,
    currentHitAt100: results.filter(item => item.current.rankTop100).length,
    currentHitAt500: results.filter(item => item.current.rankTop500).length,
    currentHitAt1000: results.filter(item => typeof item.current.rankTop1000 === 'number').length,
    currentCandidateMisses: results.filter(item => item.current.rankTop1000 === 'candidate_not_generated').length,
    standardHitAt10: results.filter(item => item.standardBm25Morphology.rankTop10).length,
    standardHitAt100: results.filter(item => item.standardBm25Morphology.rankTop100).length,
    standardHitAt500: results.filter(item => item.standardBm25Morphology.rankTop500).length,
    standardMatchedParametersHitAt1: results.filter(item => item.standardBm25MatchedParameters.rankTop10 === 1).length,
    standardMatchedParametersHitAt10: results.filter(item => item.standardBm25MatchedParameters.rankTop10).length,
    failures: failed,
    rrfHitAt1: results.filter(item => item.rrf60.rankTop10 === 1).length,
    rrfHitAt10: results.filter(item => item.rrf60.rankTop10).length,
    rrfHitAt100: results.filter(item => typeof item.rrf60.rankTop1000 === 'number' && item.rrf60.rankTop1000 <= 100).length,
    rrfHitAt1000: results.filter(item => typeof item.rrf60.rankTop1000 === 'number').length,
    rrfMrr: Number((results.reduce((sum, item) => sum + (typeof item.rrf60.rankTop1000 === 'number' ? 1 / item.rrf60.rankTop1000 : 0), 0) / Math.max(results.length, 1)).toFixed(4)),
    meanLatencyMs: Number((results.reduce((sum, item) => sum + item.latencyMs, 0) / Math.max(results.length, 1)).toFixed(2)),
    output: absoluteOutput,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
