import express from 'express';
import { healthz, showIndex } from '../controllers/system_controller.js';

export function createSystemRouter(publicDir: string) {
  const router = express.Router();
  router.get('/', showIndex(publicDir));
  router.get('/healthz', healthz);
  return router;
}
