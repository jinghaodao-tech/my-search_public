/**
 * Express application assembly for MySearch.
 * server.ts stays thin and only starts the HTTP listener.
 */
import { createSavedSearchRouter } from './routes/saved_search_routes.js';
import fs                from 'fs';
import dotenv            from 'dotenv';
import express           from 'express';
import cors              from 'cors';
import helmet            from 'helmet';
import path              from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { createRateLimiters } from './middlewares/rate_limiters.js';
import { createSystemRouter } from './routes/system_routes.js';
import { createAiRouter } from './routes/ai_routes.js';
import { createArticlesRouter } from './routes/articles_routes.js';
import { createCardsRouter } from './routes/cards_routes.js';
import { createCollectRouter } from './routes/collect_routes.js';
import { createKjRouter } from './routes/kj_routes.js';
import { createSearchRouter } from './routes/search_routes.js';
import { createCandidateRouter } from './routes/candidate_routes.js';
import { createJobsRouter } from './routes/jobs_routes.js';
import { createReaderRouter } from './routes/reader_routes.js';
import {
  requestLogger,
  notFoundHandler,
  errorHandler,
  apiKeyGuard,
  metricsMiddleware,
  metricsSnapshot,
} from './services/http_service.js';
import { createRouteContext } from './services/route_context.js';
import { DEMO_DIR, isDemoMode, seedDemoData } from './services/demo_service.js';
import { loadRuntimeConfig } from './config/runtime_config.js';
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const envPath of [
  path.join(__dirname, '.env'),
  path.join(path.dirname(__dirname), 'my-search-app', '.env'),
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const runtimeConfig = loadRuntimeConfig();

const app = express();
export { app };

const corsOrigin = runtimeConfig.CORS_ORIGIN;
const routeContext = createRouteContext(createRateLimiters());

app.use(helmet({
  contentSecurityPolicy: false,
  // The public demo is shown inside the Hugging Face Space page (an iframe on huggingface.co).
  frameguard: isDemoMode() ? false : undefined,
}));
if (isDemoMode()) {
  app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://huggingface.co"); next(); });
}
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
app.use(metricsMiddleware);
app.use('/api', apiKeyGuard);
app.get('/metrics', (_req, res) => res.json({ ok: true, metrics: metricsSnapshot() }));
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
// Sample documents for the demo (written for the demo; served for download, e.g. the sample PDF).
app.use('/demo', express.static(DEMO_DIR));
app.use(createSystemRouter(publicDir));

app.use('/api', createCollectRouter(routeContext));
app.use('/api', createSearchRouter(routeContext));
app.use('/api', createSavedSearchRouter());
app.use('/api', createCandidateRouter(routeContext));
app.use('/api', createJobsRouter(routeContext));
app.use('/api', createCardsRouter(routeContext));
app.use('/api', createAiRouter(routeContext));
app.use('/api', createKjRouter(routeContext));
app.use('/api', createArticlesRouter(routeContext));
app.use('/api', createReaderRouter(routeContext));
if (process.env.NODE_ENV === 'test') {
  app.get('/api/test/error', () => {
    throw new Error('synthetic test failure');
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

// Server bootstrap
if (process.env.NODE_ENV !== 'test') {
  if (isDemoMode()) await seedDemoData(routeContext);
  await routeContext.bootstrap();
}

const PORT = runtimeConfig.PORT;
export function startServer(port = PORT) {
  const host = process.env.HOST ?? '127.0.0.1';
  return app.listen(port, host, () => {
    logger.info({ event: 'server_start', port, url: `http://localhost:${port}` }, 'server started');
  });
}
