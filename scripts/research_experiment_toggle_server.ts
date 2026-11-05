import { app, startServer } from '../app.js';
import { db } from '../db/database.js';

const server = startServer();
let closing = false;

function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the app reference alive for the lifetime of this dedicated test server.
void app;
