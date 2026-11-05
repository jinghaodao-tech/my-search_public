import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const E5_MODEL_ID = 'Xenova/multilingual-e5-small';
const DIMENSION = 384;
const requestedCacheLimit = Number.parseInt(process.env.E5_VECTOR_CACHE_LIMIT ?? '5000', 10);
const CACHE_LIMIT = Number.isInteger(requestedCacheLimit) && requestedCacheLimit > 0 ? requestedCacheLimit : 5000;

type FeatureOutput = { data: Float32Array; dims: number[] };
type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: true }) => Promise<FeatureOutput>;

let extractorPromise: Promise<FeatureExtractor> | undefined;
const vectorCache = new Map<string, Float32Array>();

function modelCacheDirectory(): string {
  return path.resolve(process.env.E5_MODEL_CACHE_DIR ?? 'data/models');
}

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const cacheDir = modelCacheDirectory();
      const modelDir = path.join(cacheDir, E5_MODEL_ID);
      for (const file of ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json']) {
        if (!fs.existsSync(path.join(modelDir, file))) {
          throw new Error(`E5 model is not prepared in ${cacheDir}; run npm run prepare:e5-model or set E5_MODEL_CACHE_DIR.`);
        }
      }
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      env.allowRemoteModels = false;
      const instance = await pipeline('feature-extraction', E5_MODEL_ID, { dtype: 'q8' });
      return instance as unknown as FeatureExtractor;
    })().catch(error => {
      extractorPromise = undefined;
      throw error;
    });
  }
  return extractorPromise;
}

function cacheKey(text: string): string {
  return createHash('sha256').update(`${E5_MODEL_ID}\0${text.normalize('NFKC')}`).digest('hex');
}

function remember(key: string, vector: Float32Array): void {
  vectorCache.delete(key);
  vectorCache.set(key, vector);
  while (vectorCache.size > CACHE_LIMIT) vectorCache.delete(vectorCache.keys().next().value!);
}

export async function embedE5Texts(texts: readonly string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const normalized = texts.map(text => text.normalize('NFKC').trim());
  const keys = normalized.map(cacheKey);
  const missing = [...new Set(keys.filter(key => !vectorCache.has(key)))];
  if (missing.length) {
    const textByKey = new Map<string, string>();
    normalized.forEach((text, index) => textByKey.set(keys[index]!, text));
    const extractor = await getExtractor();
    for (let offset = 0; offset < missing.length; offset += 16) {
      const batchKeys = missing.slice(offset, offset + 16);
      const output = await extractor(batchKeys.map(key => textByKey.get(key)!), { pooling: 'mean', normalize: true });
      if (output.dims.at(-1) !== DIMENSION || output.data.length !== batchKeys.length * DIMENSION) {
        throw new Error(`Unexpected E5 embedding shape: ${output.dims.join('x')}`);
      }
      batchKeys.forEach((key, index) => {
        const start = index * DIMENSION;
        remember(key, output.data.slice(start, start + DIMENSION));
      });
    }
  }
  return keys.map(key => {
    const vector = vectorCache.get(key)!;
    remember(key, vector);
    return vector;
  });
}
