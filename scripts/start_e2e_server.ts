import fs from "node:fs";
import path from "node:path";

process.env.PORT ??= "3100";
process.env.DB_PATH ??= "data/e2e-test.db";
process.env.MOCK_AI_SUMMARY ??= "true";
process.env.IMPORT_RATE_LIMIT ??= "1000";

if (process.env.E2E_RESET_DB !== "false") {
  const dbPath = path.resolve(process.env.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-shm", "-wal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

await import("../server.js");
