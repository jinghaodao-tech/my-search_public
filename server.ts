/**
 * Thin server entrypoint.
 * Express app construction lives in app.ts; this file only preserves the
 * existing import path and starts the HTTP listener outside tests.
 */
import { app, startServer } from './app.js';

export { app };

if (process.env.NODE_ENV !== 'test') {
  startServer();
}
