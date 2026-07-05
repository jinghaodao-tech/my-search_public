import express from 'express';
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

export function sendError(req: express.Request, res: express.Response, status: number, error: string, details?: unknown) {
  const payload: { error: string; requestId: string; details?: unknown } = {
    error,
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

export function validationDetails(error: ZodError) {
  return error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function invalidRequest(req: express.Request, res: express.Response, details: unknown) {
  sendError(req, res, 400, 'Invalid request', details);
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
