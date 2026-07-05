import express from 'express';
import path from 'path';
import { db } from '../db/database.js';
import { getRequestId } from '../services/http_service.js';
import { errorMeta, logger } from '../utils/logger.js';

export function showIndex(publicDir: string) {
  return (_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  };
}

export function healthz(req: express.Request, res: express.Response) {
  const checkedAt = new Date().toISOString();
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM cards').get() as { count: number };
    res.json({
      ok: true,
      status: 'healthy',
      db: 'ok',
      cardCount: row.count,
      uptimeSec: Number(process.uptime().toFixed(1)),
      checkedAt,
    });
  } catch (err) {
    logger.error({ event: 'db_health_failure', requestId: getRequestId(req), error: errorMeta(err) }, 'healthz failed');
    res.status(500).json({
      ok: false,
      status: 'unhealthy',
      db: 'error',
      requestId: getRequestId(req),
      checkedAt,
    });
  }
}
