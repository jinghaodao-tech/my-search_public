import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function databaseFingerprint(file: string): string {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
    const content = tables.map(table => {
      const quoted = `"${table.name.replace(/"/gu, '""')}"`;
      const rows = database.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
      rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return { name: table.name, sql: table.sql, rows };
    });
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  } finally { database.close(); }
}

async function startApplication(databasePath: string, enabled: boolean) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const testServer = path.join(process.cwd(), 'scripts', 'research_experiment_toggle_server.ts');
  let output = '';
  const child = spawn(process.execPath, [tsxCli, testServer], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), DB_PATH: databasePath,
    API_KEY: '', CORS_ORIGIN: baseUrl, SITE_SYNC: 'off', MOCK_AI_SUMMARY: 'true', IMPORT_RATE_LIMIT: '1000',
    RESEARCH_EXPERIMENTS_ENABLED: enabled ? 'true' : 'false', RESEARCH_EXPERIMENTS_STORAGE: 'test',
  } });
  child.stdout?.on('data', chunk => { output = `${output}${chunk}`.slice(-6000); });
  child.stderr?.on('data', chunk => { output = `${output}${chunk}`.slice(-6000); });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local test app exited before readiness: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return { child, baseUrl };
    } catch { /* wait for this child process to finish startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await stopApplication(child);
  throw new Error(`Local test app did not become ready: ${output}`);
}

async function stopApplication(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = () => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
  });
  const gracefulExit = exited();
  if (child.connected) child.send('shutdown');
  else child.kill('SIGTERM');
  const graceful = await Promise.race([gracefulExit.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
  if (graceful) return;
  const forceExit = exited();
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
  } else child.kill('SIGKILL');
  await Promise.race([forceExit, new Promise<void>(resolve => setTimeout(resolve, 10_000))]);
}

async function normalBehavior(baseUrl: string) {
  const root = await fetch(`${baseUrl}/`);
  const rootHtml = await root.text();
  const cards = await fetch(`${baseUrl}/api/cards?limit=100`);
  const cardsBody = await cards.json();
  const search = await fetch(`${baseUrl}/api/cards/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    config: { label: 'toggle-invariance', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: 'toggle-fixture', weight: 1 }] },
    options: { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 10 },
    filters: { excludedTerms: [], sources: [], status: 'all' },
  }) });
  const searchBody = await search.json();
  if (searchBody.stats && typeof searchBody.stats === 'object') delete searchBody.stats.timings;
  return { rootStatus: root.status, rootHtml, cardsStatus: cards.status, cardsBody, searchStatus: search.status, searchBody };
}

test('OFF→ON→OFF leaves copied DB content and normal page/list/search responses unchanged', async () => {
  test.setTimeout(180_000);
  const sourceDb = path.resolve(process.env.E2E_DB_PATH ?? 'data/e2e-test.db');
  expect(fs.existsSync(sourceDb)).toBe(true);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `my-search-toggle-${process.pid}-`));
  const copiedDb = path.join(temporaryRoot, 'cards.db');
  const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try { await source.backup(copiedDb); } finally { source.close(); }
  const safeTempRoot = path.resolve(os.tmpdir()) + path.sep;
  const safeTarget = path.resolve(temporaryRoot);
  expect(safeTarget.startsWith(safeTempRoot)).toBe(true);
  expect(path.basename(safeTarget).startsWith(`my-search-toggle-${process.pid}-`)).toBe(true);

  let offFirst: Awaited<ReturnType<typeof startApplication>> | undefined;
  let on: Awaited<ReturnType<typeof startApplication>> | undefined;
  let offLast: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    offFirst = await startApplication(copiedDb, false);
    const baselineResponse = await normalBehavior(offFirst.baseUrl);
    expect(baselineResponse.rootStatus).toBe(200);
    expect(baselineResponse.cardsStatus).toBe(200);
    expect(baselineResponse.searchStatus).toBe(200);
    expect((await fetch(`${offFirst.baseUrl}/research-lab`)).status).toBe(404);
    expect((await fetch(`${offFirst.baseUrl}/api/research-experiments/status`)).status).toBe(404);
    const baselineFingerprint = databaseFingerprint(copiedDb);
    await stopApplication(offFirst.child); offFirst = undefined;

    on = await startApplication(copiedDb, true);
    expect((await fetch(`${on.baseUrl}/research-lab`)).status).toBe(200);
    expect((await fetch(`${on.baseUrl}/research-lab/tasks.json`)).status).toBe(200);
    const ordinaryWhileOn = await normalBehavior(on.baseUrl);
    expect(ordinaryWhileOn).toEqual(baselineResponse);
    await fetch(`${on.baseUrl}/api/research-experiments/events`, { method: 'DELETE' });
    const session = await fetch(`${on.baseUrl}/api/research-experiments/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01', presentationId: 'synthetic-form-a',
      condition: { automation: 'manual', visibility: 'current', timing: 'on_request', workflow: 'integrated' },
    }) });
    expect(session.status).toBe(201);
    const { sid } = await session.json();
    const phaseStart = await fetch(`${on.baseUrl}/api/research-experiments/sessions/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'phase_start', phase: 'search' }) });
    expect(phaseStart.status).toBe(201);
    await fetch(`${on.baseUrl}/api/research-experiments/sessions/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'phase_end', phase: 'search' }) });
    const completion = await fetch(`${on.baseUrl}/api/research-experiments/sessions/${sid}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'task_complete', outcome: 'success' }) });
    expect(completion.status).toBe(201);
    expect(databaseFingerprint(copiedDb)).toBe(baselineFingerprint);
    await fetch(`${on.baseUrl}/api/research-experiments/events`, { method: 'DELETE' });
    await stopApplication(on.child); on = undefined;

    offLast = await startApplication(copiedDb, false);
    const afterOff = await normalBehavior(offLast.baseUrl);
    expect(afterOff).toEqual(baselineResponse);
    expect(databaseFingerprint(copiedDb)).toBe(baselineFingerprint);
    expect((await fetch(`${offLast.baseUrl}/research-lab`)).status).toBe(404);
    expect((await fetch(`${offLast.baseUrl}/api/research-experiments/status`)).status).toBe(404);
  } finally {
    if (offFirst) await stopApplication(offFirst.child);
    if (on) await stopApplication(on.child);
    if (offLast) await stopApplication(offLast.child);
    if (path.resolve(temporaryRoot).startsWith(safeTempRoot) && path.basename(temporaryRoot).startsWith(`my-search-toggle-${process.pid}-`)) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});
