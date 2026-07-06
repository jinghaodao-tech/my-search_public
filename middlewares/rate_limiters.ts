import rateLimit from 'express-rate-limit';
import { getRequestId, sendError } from '../services/http_service.js';
import { logger } from '../utils/logger.js';

export function createRateLimiters() {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT ?? 60),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ event: 'rate_limit', requestId: getRequestId(req), method: req.method, path: req.path }, 'rate limit exceeded');
      sendError(req, res, 429, 'Rate limit exceeded');
    },
  });

  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.AI_RATE_LIMIT ?? 10),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ event: 'rate_limit', requestId: getRequestId(req), method: req.method, path: req.path, bucket: 'ai' }, 'rate limit exceeded');
      sendError(req, res, 429, 'Rate limit exceeded');
    },
  });

  const importLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: Number(process.env.IMPORT_RATE_LIMIT ?? 10),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn({ event: 'rate_limit', requestId: getRequestId(req), method: req.method, path: req.path, bucket: 'import' }, 'rate limit exceeded');
      sendError(req, res, 429, 'Rate limit exceeded');
    },
  });

  return { apiLimiter, aiLimiter, importLimiter };
}
