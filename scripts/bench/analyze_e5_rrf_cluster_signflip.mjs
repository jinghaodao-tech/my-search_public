import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const artifactDir = resolve('quality/e2e/artifacts');
const defaultFiles = [
  'fiqa-dev-e5-embedding-transfer-20261024.json',
  'scifact-test-e5-embedding-transfer-20261024.json',
  'scidocs-test-e5-rrf-transfer-20261024.json',
  'nfcorpus-test-e5-embedding-transfer-20261024.json',
  'arguana-test-e5-embedding-transfer-20261024.json',
  'miracl-ja-subset-e5-transfer-20261024.json',
];

const args = process.argv.slice(2);
const permutationsArg = args.find((arg) => arg.startsWith('--permutations='));
const outputArg = args.find((arg) => arg.startsWith('--out='));
const permutations = Number(permutationsArg?.split('=')[1] ?? 50_000);
if (!Number.isSafeInteger(permutations) || permutations < 1) {
  throw new Error('--permutations must be a positive integer');
}

function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function seededRandom(seed) {
  let state = Number.parseInt(seed.slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function testClusterSums(clusterSums, observed, seed) {
  if (clusterSums.length <= 20) {
    const total = 2 ** clusterSums.length;
    let atLeastObserved = 0;
    for (let mask = 0; mask < total; mask += 1) {
      let permuted = 0;
      for (let i = 0; i < clusterSums.length; i += 1) {
        permuted += (mask & (2 ** i)) !== 0 ? clusterSums[i] : -clusterSums[i];
      }
      if (permuted >= observed - 1e-12) atLeastObserved += 1;
    }
    return { pValue: atLeastObserved / total, draws: total, exact: true };
  }

  const random = seededRandom(seed);
  let atLeastObserved = 0;
  for (let draw = 0; draw < permutations; draw += 1) {
    let permuted = 0;
    for (const sum of clusterSums) permuted += (random() & 1) ? sum : -sum;
    if (permuted >= observed - 1e-12) atLeastObserved += 1;
  }
  return {
    pValue: (atLeastObserved + 1) / (permutations + 1),
    draws: permutations,
    exact: false,
  };
}

const results = [];
for (const name of defaultFiles) {
  const path = resolve(artifactDir, name);
  const bytes = await readFile(path);
  const artifact = JSON.parse(bytes.toString('utf8'));
  const clusterSums = new Map();
  let queryCount = 0;

  for (const query of artifact.perQuery) {
    const delta = query['rrf-bm25-e5'].metrics.ndcg10 - query['standard-bm25'].metrics.ndcg10;
    if (!Number.isFinite(delta) || typeof query.groupId !== 'string') {
      throw new Error(`Invalid paired query record in ${name}`);
    }
    clusterSums.set(query.groupId, (clusterSums.get(query.groupId) ?? 0) + delta);
    queryCount += 1;
  }

  const sums = [...clusterSums.values()];
  const observed = sums.reduce((total, value) => total + value, 0);
  const test = testClusterSums(sums, observed, hashHex(name));
  results.push({
    dataset: artifact.dataset?.name ?? basename(name),
    artifact: name,
    artifactSha256: hashHex(bytes),
    queryCount,
    clusterCount: sums.length,
    observedMeanNdcgDelta: observed / queryCount,
    alternative: 'RRF nDCG@10 > standard BM25 nDCG@10',
    ...test,
  });
}

const ordered = results.map((result, index) => ({ index, pValue: result.pValue }))
  .sort((a, b) => a.pValue - b.pValue);
let previousAdjusted = 0;
for (let rank = 0; rank < ordered.length; rank += 1) {
  const item = ordered[rank];
  previousAdjusted = Math.max(previousAdjusted, Math.min(1, item.pValue * (ordered.length - rank)));
  results[item.index].holmAdjustedP = previousAdjusted;
}

const output = {
  analysis: 'post-hoc one-sided paired cluster sign-flip test',
  familySize: results.length,
  alpha: 0.05,
  monteCarloPermutations: permutations,
  correction: 'Holm step-down across the six listed datasets',
  warning: 'Exploratory datasets were previously inspected; this is not an independent confirmatory evaluation.',
  results,
};

const json = `${JSON.stringify(output, null, 2)}\n`;
if (outputArg) await writeFile(resolve(outputArg.split('=').slice(1).join('=')), json);
process.stdout.write(json);
