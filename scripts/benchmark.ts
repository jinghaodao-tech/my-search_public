import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MODES, runPipeline, type Article, type BenchmarkTimings } from "../bm25_engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
process.env.DB_PATH ??= path.join(os.tmpdir(), "my-search-benchmark.sqlite");
const corpusSizes = [100, 1_000, 5_000, 10_000];
const resultLimit = Number(process.env.BENCH_RESULT_LIMIT ?? 100);
const benchmarkMode = {
  ...MODES.impl!,
  keywords: [
    { term: "search", weight: 2, synonyms: ["bm25"] },
    { term: "implementation", weight: 1.5, synonyms: ["code"] },
    { term: "sqlite", weight: 1.2, synonyms: ["database"] },
    { term: "performance", weight: 1.1, synonyms: ["benchmark"] },
  ],
};

const originalConsoleTime = console.time;
const originalConsoleTimeEnd = console.timeEnd;

console.time = () => undefined;
console.timeEnd = () => undefined;

function roundMs(value: number | undefined): number {
  return Number((value ?? 0).toFixed(3));
}

function ms(value: number | undefined): string {
  return `${roundMs(value).toLocaleString("en-US")} ms`;
}

function makeArticle(index: number): Article {
  const group = index % 10;
  const tokens = [
    "search",
    "implementation",
    "sqlite",
    "bm25",
    `group-${group}`,
    `card-${index}`,
  ];
  if (index % 3 === 0) tokens.push("github", "repository");
  if (index % 5 === 0) tokens.push("performance", "benchmark");
  if (index % 7 === 0) tokens.push("api", "validation");

  return {
    id: `bench-${index}`,
    title: `Benchmark card ${index}`,
    body: `Benchmark body ${index} about BM25 search, SQLite, implementation, and local knowledge management.`,
    publishedAt: new Date(Date.UTC(2026, 0, 1 + (index % 30))),
    sourceAuthority: 1,
    url: `https://example.com/bench-${index}`,
    tokens,
    docLength: tokens.length,
    tags: ["benchmark", `group-${group}`],
    type: "memo",
  };
}

function makeCorpus(size: number): Article[] {
  return Array.from({ length: size }, (_, index) => makeArticle(index));
}

function makeProductionCorpus(size: number): Article[] {
  return Array.from({ length: size }, (_, index) => {
    const article = makeArticle(index);
    // Model a realistic corpus: mostly distinct cards with small near-duplicate
    // clusters, instead of making every synthetic document share one body.
    if (index % 10 === 0) {
      const cluster = Math.floor(index / 10);
      return {
        ...article,
        title: `Benchmark cluster ${cluster}`,
        body: `Cluster ${cluster} discusses search implementation, SQLite indexing, and local knowledge management. Variant ${index} records the same source with a small capture difference.`,
      };
    }
    if (index % 10 !== 1) {
      return {
        ...article,
        body: `Distinct benchmark document ${index} covers topic-${index} and project-${index % 997}, with independent notes about local search behavior.`,
      };
    }
    const cluster = Math.floor((index - 1) / 10);
    return {
      ...article,
      title: `Benchmark cluster ${cluster} follow-up`,
      body: `Cluster ${cluster} discusses search implementation, SQLite indexing, and local knowledge management. Variant ${index} records the same source with a follow-up note.`,
    };
  });
}

function makeCandidateCorpus(size: number, nearDuplicate: boolean): Article[] {
  return Array.from({ length: size }, (_, index) => ({ ...makeArticle(index), id: "candidate-" + (nearDuplicate ? "near-" : "diverse-") + index, body: nearDuplicate ? "Repeated candidate article about search and implementation." : "Distinct candidate article " + index + " about search and implementation " + index + "." }));
}

async function benchmarkCorpus(size: number) {
  const { loadCards } = await import("../cards_engine.js");
  const dbStart = performance.now();
  loadCards();
  const dbLoadMs = performance.now() - dbStart;

  const totalStart = performance.now();
  const result = await runPipeline(makeCorpus(size), benchmarkMode, "benchmark", {
    archiveScoreThreshold: -1,
    dedupThreshold: 1,
    resultLimit,
  });
  const totalSearchMs = performance.now() - totalStart;
  const timings: BenchmarkTimings = {
    dbLoadMs: roundMs(dbLoadMs),
    tokenPreparationMs: roundMs(result.stats.timings?.tokenPreparationMs),
    scoringMs: roundMs(result.stats.timings?.scoringMs),
    sortingLimitMs: roundMs(result.stats.timings?.sortingLimitMs),
    totalSearchMs: roundMs(totalSearchMs),
  };

  return {
    corpusSize: size,
    resultLimit,
    activeResults: result.active.length,
    matchedBeforeLimit: result.stats.activeCount,
    timings,
  };
}

async function benchmarkScope(scope: 'ranking-only' | 'production-like' | 'end-to-end-pipeline' | 'first-pipeline-call' | 'repeated-pipeline-call', size: number) {
  const options = {
    archiveScoreThreshold: scope === 'production-like' ? 0.1 : -1,
    dedupThreshold: scope === 'production-like' ? 0.8 : 1,
    resultLimit,
  };
  const corpus = scope === "production-like" ? makeProductionCorpus(size) : makeCorpus(size);
  if (scope === "repeated-pipeline-call") await runPipeline(corpus, benchmarkMode, `benchmark-${scope}-warmup`, options);
  const started = performance.now();

  await runPipeline(corpus, benchmarkMode, `benchmark-${scope}`, options);
  return { scope, corpusSize: size, elapsedMs: roundMs(performance.now() - started), dedupEnabled: options.dedupThreshold < 1, resultLimit };
}
async function benchmarkCandidateScope(name: "candidate-pipeline-near-duplicate" | "candidate-pipeline-diverse", nearDuplicate: boolean) {
  const started = performance.now();
  const result = await runPipeline(makeCandidateCorpus(200, nearDuplicate), benchmarkMode, name, { archiveScoreThreshold: -1, dedupThreshold: nearDuplicate ? 0.8 : 1, resultLimit: 100 });
  return { scope: name, corpusSize: 200, elapsedMs: roundMs(performance.now() - started), afterDedup: result.stats.afterDedup, activeCount: result.stats.activeCount };
}


function writeMarkdown(results: Awaited<ReturnType<typeof benchmarkCorpus>>[], scopes: Array<{ scope: string; corpusSize: number; elapsedMs: number; dedupEnabled: boolean; resultLimit: number }>, candidateScopes: Array<{ scope: string; corpusSize: number; elapsedMs: number; afterDedup: number; activeCount: number }>): void {
  const generatedAt = new Date().toISOString();
  const rows = results
    .map((result) => {
      const t = result.timings;
      return `| ${result.corpusSize.toLocaleString("en-US")} | ${ms(t.dbLoadMs)} | ${ms(t.tokenPreparationMs)} | ${ms(t.scoringMs)} | ${ms(t.sortingLimitMs)} | ${ms(t.totalSearchMs)} | ${result.activeResults} |`;
    })
    .join("\n");

  const markdown = `# BM25 Benchmark

Generated: ${generatedAt}

Command:

\`\`\`bash
npm run benchmark
\`\`\`

The benchmark uses deterministic synthetic card corpora with precomputed \`tokens\` and \`docLength\`, matching the production SQLite design where \`tokens_json\` and \`doc_length\` are generated on write instead of tokenizing every card during search.

Ranking, production-like, and end-to-end pipeline rows are measured independently. The first-pipeline-call row has no prior pipeline warm-up; the repeated-pipeline-call row performs an excluded warm-up immediately before its measured call.

## Results

| Corpus size | DB load | Token parse / preparation | BM25 scoring | Sorting / limiting | Total search | Returned |
|---:|---:|---:|---:|---:|---:|---:|
${rows}

## Scope Results

| Scope | Corpus | Elapsed | Dedup | Result limit |
|---|---:|---:|---|---:|
${scopes.map(scope => `| ${scope.scope} | ${scope.corpusSize.toLocaleString("en-US")} | ${ms(scope.elapsedMs)} | ${scope.dedupEnabled ? "enabled" : "disabled"} | ${scope.resultLimit} |`).join("\n")}

## End-to-end HTTP

Run \`npm run benchmark:http\` to measure an actual \`GET /api/cards\` route with first-http-request-after-server-start and warm-http-request timings. This is kept separate from the deterministic ranking corpus table.

## Before / After

Historical baseline before token precomputation:

| Stage | Before | Current benchmark focus |
|---|---:|---:|
| Load cards | 2.175 ms | measured as DB load |
| Tokenize | 4.584 s | measured as token parse / preparation |
| Score | 4.705 s | measured as BM25 scoring |
| Total BM25 | 9.705 s | measured as total search |

## What Changed

- Search uses precomputed \`tokens_json\` and \`doc_length\` instead of running morphological tokenization for every card on every query.
- BM25 scoring avoids creating one Promise per card because scoring is CPU-bound and synchronous.
- Benchmarks now report DB load, token preparation, scoring, sorting/limiting, and total search separately.
- Benchmark corpora cover 100, 1,000, 5,000, and 10,000 cards.
- First-pipeline-call intentionally includes first-call cost; repeated-pipeline-call excludes only its own pre-measurement warm-up.
- Deduplication is skipped when \`dedupThreshold >= 1\`, which is the expected benchmark and acceptance-test setting for measuring ranking rather than duplicate detection.

## Remaining Bottlenecks

- Token arrays still need to be normalized and counted into term-frequency maps during each search.
- Full result sorting is still used after scoring; a bounded top-K heap could reduce work for small \
esultLimit\` values.
- DB load is measured separately here, but production searches still parse \`tokens_json\` from SQLite rows into JavaScript arrays.

## Why This Matters

BM25 is only useful in the GUI if search latency stays predictable as the local-first card corpus grows. Separating benchmark stages makes future regressions easier to diagnose and makes the next optimization target clear.
`;

  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "benchmark.md"), markdown, "utf-8");
}


const results = [];
for (const size of corpusSizes) {
  results.push(await benchmarkCorpus(size));
}

const candidateScopes = [
  await benchmarkCandidateScope("candidate-pipeline-near-duplicate", true),
  await benchmarkCandidateScope("candidate-pipeline-diverse", false),
];

const scopes = [
  await benchmarkScope("ranking-only", 10000),
  await benchmarkScope("production-like", 5000),
  await benchmarkScope("end-to-end-pipeline", 1000),
  await benchmarkScope("first-pipeline-call", 100),
  await benchmarkScope("repeated-pipeline-call", 100),
];
writeMarkdown(results, scopes, candidateScopes);
const candidateMarkdown = `

## Candidate pipeline scopes

| Scope | Corpus | Elapsed | After dedup | Active |
|---|---:|---:|---:|---:|
${candidateScopes.map(scope => "| " + scope.scope + " | " + scope.corpusSize + " | " + ms(scope.elapsedMs) + " | " + scope.afterDedup + " | " + scope.activeCount + " |").join("\n")}`
fs.appendFileSync(path.join(projectRoot, "docs", "benchmark.md"), candidateMarkdown, "utf-8");
const performanceThresholds = { rankingOnlyMs: 500, productionLikeMs: 3000, endToEndPipelineMs: 1000, firstPipelineCallMs: 1000, repeatedPipelineCallMs: 100, candidatePipelineMs: 1000 };
const performanceFailures = [
  scopes.find(scope => scope.scope === 'ranking-only' && scope.elapsedMs > performanceThresholds.rankingOnlyMs) ? 'ranking-only' : null,
  scopes.find(scope => scope.scope === 'production-like' && scope.elapsedMs > performanceThresholds.productionLikeMs) ? 'production-like' : null,
  scopes.find(scope => scope.scope === 'end-to-end-pipeline' && scope.elapsedMs > performanceThresholds.endToEndPipelineMs) ? 'end-to-end-pipeline' : null,
  scopes.find(scope => scope.scope === 'first-pipeline-call' && scope.elapsedMs > performanceThresholds.firstPipelineCallMs) ? 'first-pipeline-call' : null,
  scopes.find(scope => scope.scope === 'repeated-pipeline-call' && scope.elapsedMs > performanceThresholds.repeatedPipelineCallMs) ? 'repeated-pipeline-call' : null,
  candidateScopes.find(scope => scope.elapsedMs > performanceThresholds.candidatePipelineMs) ? 'candidate-pipeline' : null,
].filter(Boolean);
const benchmarkArtifact = { generatedAt: new Date().toISOString(), resultLimit, results, scopes, candidateScopes, performanceThresholds, performanceFailures };
fs.mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(projectRoot, "artifacts", "benchmark-results.json"), JSON.stringify(benchmarkArtifact, null, 2), "utf-8");
console.log(JSON.stringify({ ok: true, ...benchmarkArtifact }, null, 2));
if (performanceFailures.length) process.exitCode = 1;

console.time = originalConsoleTime;
console.timeEnd = originalConsoleTimeEnd;
