/**
 * Express application assembly for MySearch.
 * server.ts stays thin and only starts the HTTP listener.
 */
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
import {
  requestLogger,
  notFoundHandler,
  errorHandler,
  apiKeyGuard,
  metricsMiddleware,
  metricsSnapshot,
} from './services/http_service.js';
import { createRouteContext } from './services/route_context.js';
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
}));
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
app.use(metricsMiddleware);
app.use('/api', apiKeyGuard);
app.get('/metrics', (_req, res) => res.json({ ok: true, metrics: metricsSnapshot() }));
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.use(createSystemRouter(publicDir));

app.use('/api', createCollectRouter(routeContext));
app.use('/api', createSearchRouter(routeContext));
app.use('/api', createCandidateRouter(routeContext));
app.use('/api', createJobsRouter(routeContext));
app.use('/api', createCardsRouter(routeContext));
app.use('/api', createAiRouter(routeContext));
app.use('/api', createKjRouter(routeContext));
app.use('/api', createArticlesRouter(routeContext));
if (process.env.NODE_ENV === 'test') {
  app.get('/api/test/error', () => {
    throw new Error('synthetic test failure');
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

// Server bootstrap
if (process.env.NODE_ENV !== 'test') {
  await routeContext.bootstrap();
}

const PORT = runtimeConfig.PORT;
export function startServer(port = PORT) {
  const host = process.env.HOST ?? '127.0.0.1';
  return app.listen(port, host, () => {
    logger.info({ event: 'server_start', port, url: `http://localhost:${port}` }, 'server started');
  });
}
