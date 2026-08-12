import express from 'express';
import crypto from 'node:crypto';
import { randomUUID } from 'crypto';
import { type ZodError, type ZodType } from 'zod';
import { errorMeta, logger } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export type AppErrorCode =
  | 'validation_failed'
  | 'card_not_found'
  | 'candidate_not_found'
  | 'candidate_already_saved'
  | 'candidate_expired'
  | 'candidate_save_conflict'
  | 'group_not_found'
  | 'link_invalid'
  | 'import_invalid'
  | 'collector_failed'
  | 'search_failed'
  | 'export_failed'
  | 'ai_provider_unavailable'
  | 'database_error'
  | 'card_create_failed'
  | 'article_import_failed'
  | 'import_failed'
  | 'link_not_found'
  | 'scheduler_already_running'
  | 'job_not_found'
  | 'authentication_required'
  | 'request_failed';
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function getRequestId(req: express.Request): string {
  return req.requestId ?? String(req.get('x-request-id') ?? '');
}

export function sendError(req: express.Request, res: express.Response, status: number, error: string, details?: unknown, code: AppErrorCode = 'request_failed') {
  const payload: { error: string; code: AppErrorCode; requestId: string; details?: unknown } = {
    error,
    code,
    requestId: getRequestId(req),
  };
  if (details !== undefined) payload.details = details;
  res.status(status).json(payload);
}
export function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction) {
  const started = Date.now();
  const incomingRequestId = req.header('x-request-id')?.trim();
  const requestId = incomingRequestId || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  logger.debug({ event: 'request_start', requestId, method: req.method, path: req.path }, 'request start');
  res.on('finish', () => {
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      event: 'request_end',
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      responseTimeMs: Date.now() - started,
    }, 'request complete');
  });
  next();
}

const requestMetrics = new Map<string, { count: number; errors: number; totalMs: number }>();
export function metricsMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const started = Date.now();
  const key = `${req.method} ${req.path}`;
  const current = requestMetrics.get(key) ?? { count: 0, errors: 0, totalMs: 0 };
  current.count += 1;
  requestMetrics.set(key, current);
  res.on('finish', () => {
    current.errors += res.statusCode >= 400 ? 1 : 0;
    current.totalMs += Date.now() - started;
    requestMetrics.set(key, current);
  });
  next();
}

export function metricsSnapshot() {
  return [...requestMetrics.entries()].map(([route, value]) => ({ route, ...value, averageMs: value.count ? Number((value.totalMs / value.count).toFixed(2)) : 0 }));
}

export function apiKeyGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expected = process.env.API_KEY?.trim();
  if (!expected) {
    next();
    return;
  }
  const actual = req.header('x-api-key')?.trim() ?? '';
  if (actual.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    sendError(req, res, 401, 'API key required', undefined, 'authentication_required');
    return;
  }
  next();
}

export function validationDetails(error: ZodError) {
  return error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function invalidRequest(req: express.Request, res: express.Response, details: unknown) {
  sendError(req, res, 400, 'Invalid request', details, 'validation_failed');
}

export function parseBody<T>(schema: ZodType<T>, req: express.Request, res: express.Response): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(req, res, validationDetails(parsed.error));
    return null;
  }
  return parsed.data;
}

export function notFoundHandler(req: express.Request, res: express.Response) {
  sendError(req, res, 404, 'Not found');
}

export function errorHandler(err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) {
  const status = err instanceof HttpError ? err.status : 500;
  const error = status === 500 ? 'Internal server error' : err instanceof Error ? err.message : 'Request failed';
  logger.error({
    event: 'unhandled_error',
    requestId: getRequestId(req),
    method: req.method,
    path: req.path,
    statusCode: status,
    error: errorMeta(err),
  }, 'request failed');
  if (res.headersSent) return;
  sendError(req, res, status, error);
}
