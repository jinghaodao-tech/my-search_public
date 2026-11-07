/**
 * Express application assembly for MySearch.
 * server.ts stays thin and only starts the HTTP listener.
 */
import { createSavedSearchRouter } from './routes/saved_search_routes.js';
import { PROJECT_ROOT } from './utils/project_root.js';
import fs                from 'fs';
import dotenv            from 'dotenv';
import express           from 'express';
import cors              from 'cors';
import helmet            from 'helmet';
import path              from 'path';
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
import { createDiscoverRouter } from './routes/discover_routes.js';
import { createSiteRouter } from './routes/site_routes.js';
import { createRefindStudyRouter } from './routes/refind_study_routes.js';
import { createResearchExperimentRouter, isTrustedLocalRequest } from './routes/research_experiment_routes.js';
import { createDocumentsRouter } from './routes/documents_routes.js';
import { assessSiteRun, startSiteScheduler, syncSite } from './services/site_collector.js';
import { safeFetch } from './services/safe_fetch.js';
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

const __dirname = PROJECT_ROOT;

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
if (runtimeConfig.RESEARCH_EXPERIMENTS_ENABLED) {
  app.use('/api/research-experiments', express.json({ limit: '8kb' }));
  app.use('/api/research-experiments', (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    next(error);
  });
}
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);
app.use(metricsMiddleware);
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.header('origin');
  if (!origin) return next(); // non-browser clients do not send Origin; API key policy still applies.
  const hostOrigin = `${req.protocol}://${req.header('host') ?? ''}`;
  const normalize = (value: string) => { try { return new URL(value).origin; } catch { return ''; } };
  const allowed = new Set([normalize(hostOrigin), normalize(corsOrigin)].filter(Boolean));
  if (allowed.has(normalize(origin))) return next();
  res.status(403).json({ error: 'cross_origin_mutation_blocked' });
});
app.use('/api', apiKeyGuard);
app.get('/metrics', (_req, res) => res.json({ ok: true, metrics: metricsSnapshot() }));
const publicDir = path.join(__dirname, 'public');
const pdfJsBrowserDir = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build');
app.get('/vendor/pdfjs/pdf.mjs', (_req, res, next) => res.type('application/javascript').sendFile(path.join(pdfJsBrowserDir, 'pdf.mjs'), error => { if (error) next(error); }));
app.get('/vendor/pdfjs/pdf.worker.mjs', (_req, res, next) => res.type('application/javascript').sendFile(path.join(pdfJsBrowserDir, 'pdf.worker.mjs'), error => { if (error) next(error); }));
app.use('/vendor/pdfjs/cmaps', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps'), { fallthrough: false, index: false }));
app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts'), { fallthrough: false, index: false }));
if (runtimeConfig.RESEARCH_EXPERIMENTS_ENABLED) {
  app.get('/research-lab', (req, res, next) => {
    if (!isTrustedLocalRequest({ remoteAddress: req.socket.remoteAddress ?? '', localAddress: req.socket.localAddress ?? '', host: req.header('host') ?? '', origin: req.header('origin') })) return res.status(403).json({ error: 'local_only' });
    res.sendFile(path.join(__dirname, 'quality', 'e0e6', 'research-lab.html'), error => { if (error) next(error); });
  });
  app.get('/research-lab.js', (req, res, next) => {
    if (!isTrustedLocalRequest({ remoteAddress: req.socket.remoteAddress ?? '', localAddress: req.socket.localAddress ?? '', host: req.header('host') ?? '', origin: req.header('origin') })) return res.status(403).json({ error: 'local_only' });
    res.type('application/javascript').sendFile(path.join(__dirname, 'quality', 'e0e6', 'research-lab.js'), error => { if (error) next(error); });
  });
  app.get('/research-lab/tasks.json', (req, res, next) => {
    if (!isTrustedLocalRequest({ remoteAddress: req.socket.remoteAddress ?? '', localAddress: req.socket.localAddress ?? '', host: req.header('host') ?? '', origin: req.header('origin') })) return res.status(403).json({ error: 'local_only' });
    res.type('application/json').sendFile(path.join(__dirname, 'quality', 'e0e6', 'synthetic_tasks.json'), error => { if (error) next(error); });
  });
}
app.use(express.static(publicDir));
// IR benchmarks (scripts/bench/README.md): only when BENCH_DIR is set, never in the public demo.
if (process.env.BENCH_DIR && !isDemoMode()) {
  app.use('/bench', express.static(path.resolve(process.env.BENCH_DIR)));
  app.use('/bench', express.static(path.join(PROJECT_ROOT, 'scripts', 'bench')));
}
// Sample documents for the demo (written for the demo; served for download, e.g. the sample PDF).
app.use('/demo', express.static(DEMO_DIR));
app.use(createSystemRouter(publicDir));

app.use('/api', createCollectRouter(routeContext));
app.use('/api', createSearchRouter(routeContext));
app.use('/api', createSavedSearchRouter());
app.use('/api', createCandidateRouter(routeContext));
app.use('/api', createJobsRouter(routeContext));
app.use('/api', createCardsRouter(routeContext));
app.use('/api', createDocumentsRouter());
app.use('/api', createRefindStudyRouter({
  directory: path.join(__dirname, 'quality', 'e2e', 'local', 'personal-refind', 'study'),
  root: __dirname,
  getCards: routeContext.loadCards,
  getCard: routeContext.getCard,
}));
if (runtimeConfig.RESEARCH_EXPERIMENTS_ENABLED) {
  const storeDirectory = runtimeConfig.RESEARCH_EXPERIMENTS_STORAGE === 'test' ? 'test-local' : 'local';
  app.use('/api', createResearchExperimentRouter({ directory: path.join(__dirname, 'quality', 'e0e6', storeDirectory), retentionDays: runtimeConfig.RESEARCH_EXPERIMENT_RETENTION_DAYS, startRetentionTimer: true }));
}
app.use('/api', createAiRouter(routeContext));
app.use('/api', createKjRouter(routeContext));
app.use('/api', createArticlesRouter(routeContext));
app.use('/api', createReaderRouter(routeContext));
app.use('/api', createDiscoverRouter(routeContext));
app.use('/api', createSiteRouter(routeContext));
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
  // Registered sites: each one is checked for new articles about once a day.
  if (process.env.SITE_SYNC !== 'off') startSiteScheduler(safeFetch, () => routeContext.setCachedArticles(null), (site, fetch, mode) => {
    const completed = syncSite(site, fetch, mode);
    routeContext.submitJob('site-scheduled-sync', () => completed, assessSiteRun);
    return completed;
  });
}

const PORT = runtimeConfig.PORT;
export function startServer(port = PORT) {
  const host = process.env.HOST ?? '127.0.0.1';
  return app.listen(port, host, () => {
    logger.info({ event: 'server_start', port, url: `http://localhost:${port}` }, 'server started');
  });
}
