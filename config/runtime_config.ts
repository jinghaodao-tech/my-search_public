import { z } from 'zod';

const optionalNumber = (fallback: number) => z.preprocess(value => value === undefined || value === '' ? fallback : value, z.coerce.number().finite());
const runtimeConfigSchema = z.object({
  PORT: optionalNumber(3000).pipe(z.number().int().min(1).max(65535)),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  DB_PATH: z.string().default('data/cards.db'),
  STORAGE_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  POSTGRES_URL: z.string().optional(),
  API_KEY: z.string().optional(),
  SEARCH_ENGINE: z.enum(['bm25', 'hybrid']).default('bm25'),
  CARD_SEARCH_ENGINE: z.enum(['like', 'fts5']).default('like'),
  API_RATE_LIMIT: optionalNumber(60).pipe(z.number().int().positive()),
  IMPORT_RATE_LIMIT: optionalNumber(10).pipe(z.number().int().positive()),
  AI_RATE_LIMIT: optionalNumber(10).pipe(z.number().int().positive()),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = runtimeConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid runtime configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}
