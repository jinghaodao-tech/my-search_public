import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { E5_MODEL_ID } from '../services/e5_embedding_service.js';

const cacheDir = path.resolve(process.env.E5_MODEL_CACHE_DIR ?? 'data/models');
env.cacheDir = cacheDir;
env.allowRemoteModels = true;
console.log(`Preparing ${E5_MODEL_ID} in ${cacheDir}. This explicit command may download model files.`);
const extractor = await pipeline('feature-extraction', E5_MODEL_ID, { dtype: 'q8' });
const probe = await extractor(['query: model setup check'], { pooling: 'mean', normalize: true });
if (probe.dims.at(-1) !== 384 || probe.data.length !== 384) throw new Error(`Unexpected embedding shape: ${probe.dims.join('x')}`);
console.log(`E5 model is ready at ${cacheDir}.`);
