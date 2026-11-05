import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.join(root, 'quality/e2e/local/embedding-runtime');
const require = createRequire(path.join(runtimeRoot, 'runner.cjs'));
const { env, pipeline } = require('@huggingface/transformers');
env.cacheDir = path.join(root, 'quality/e2e/local/embedding-cache');
env.allowRemoteModels = true;

const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
  dtype: 'q8',
  progress_callback: event => {
    if (event.status === 'progress' || event.status === 'done') {
      console.log(JSON.stringify({ status: event.status, file: event.file, progress: event.progress }));
    }
  },
});
const inputs = [
  'query: SQLiteの同時書き込みとロックの仕組み',
  'passage: SQLite permits multiple readers but serializes concurrent writes using database locks.',
  'passage: A recipe for making steamed rice in a kitchen.',
];
const started = performance.now();
const embeddings = await extractor(inputs, { pooling: 'mean', normalize: true });
const vectors = [];
const dimension = embeddings.dims.at(-1);
if (!Number.isInteger(dimension) || dimension < 1) throw new Error(`Unexpected output dimensions: ${embeddings.dims.join('x')}`);
for (let row = 0; row < inputs.length; row++) {
  const vector = Array.from(embeddings.data.slice(row * dimension, (row + 1) * dimension));
  if (vector.some(value => !Number.isFinite(value))) throw new Error('Embedding contains non-finite values.');
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (Math.abs(norm - 1) > 1e-3) throw new Error(`Expected normalized vector, got L2 norm ${norm}.`);
  vectors.push(vector);
}
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
console.log(JSON.stringify({ model: 'Xenova/multilingual-e5-small', dtype: 'q8', pooling: 'mean', normalized: true,
  dimension, queryRelevantCosine: dot(vectors[0], vectors[1]), queryUnrelatedCosine: dot(vectors[0], vectors[2]),
  batchInferenceMs: performance.now() - started, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed }, null, 2));
