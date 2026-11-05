import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResearchExperimentRouter, isTrustedLocalRequest } from '../routes/research_experiment_routes.js';

describe('local synthetic research experiment API', () => {
  let directory: string;
  let app: express.Express;
  let clock: Date;
  let retentionDays = 30;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'my-search-e0e6-'));
    clock = new Date('2026-11-05T00:00:00.000Z');
    app = express();
    app.use(express.json());
    app.use('/api', createResearchExperimentRouter({ directory, now: () => clock, get retentionDays() { return retentionDays; } }));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('requires explicit consent and rejects query or article data at the API boundary', async () => {
    expect((await request(app).post('/api/research-experiments/sessions').send({ consent: false, experiment: 'E0', taskId: 'synthetic-refind-01' })).status).toBe(400);
    expect((await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E0', taskId: 'synthetic-refind-01', query: 'private search' })).status).toBe(400);
    expect(fs.existsSync(path.join(directory, 'events.jsonl'))).toBe(false);
  });

  it('requires a loopback socket, literal local Host, and a same-origin request to resist DNS rebinding', () => {
    const local = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', host: '127.0.0.1:3000' };
    expect(isTrustedLocalRequest(local)).toBe(true);
    expect(isTrustedLocalRequest({ ...local, host: 'attacker.test' })).toBe(false);
    expect(isTrustedLocalRequest({ ...local, origin: 'http://attacker.test' })).toBe(false);
    expect(isTrustedLocalRequest({ ...local, origin: 'http://127.0.0.1:3001' })).toBe(false);
    expect(isTrustedLocalRequest({ ...local, origin: 'http://127.0.0.1:3000' })).toBe(true);
    expect(isTrustedLocalRequest({ ...local, remoteAddress: '203.0.113.4' })).toBe(false);
    expect(isTrustedLocalRequest({ ...local, localAddress: '0.0.0.0' })).toBe(false);
  });

  it('rejects an untrusted Host or mismatched Origin at the HTTP boundary', async () => {
    expect((await request(app).get('/api/research-experiments/status').set('Host', 'attacker.test')).status).toBe(403);
    expect((await request(app).get('/api/research-experiments/status').set('Origin', 'http://attacker.test')).status).toBe(403);
    expect((await request(app).get('/api/research-experiments/status').set('Origin', 'https://127.0.0.1')).status).toBe(403);
  });

  it('records only synthetic identifiers and categorical events, computes wall time once, and supports withdrawal', async () => {
    const started = await request(app).post('/api/research-experiments/sessions').send({
      consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01',
      condition: { automation: 'manual', visibility: 'current', timing: 'on_request', workflow: 'integrated' },
    });
    expect(started.status).toBe(201);
    expect(started.body.workflowDefinitionId).toBe('e6-integrated-auto-share-v2');
    const sid = started.body.sid as string;
    clock = new Date('2026-11-05T00:00:05.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'phase_start', phase: 'read', url: 'https://private.test' })).status).toBe(400);
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'phase_start', phase: 'read' })).status).toBe(201);
    clock = new Date('2026-11-05T00:00:07.000Z');
    const ended = await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'phase_end', phase: 'read' });
    expect(ended.status).toBe(201);
    expect(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).toContain('"duration_ms":2000');
    clock = new Date('2026-11-05T00:00:09.000Z');
    const completed = await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'task_complete', outcome: 'success' });
    expect(completed.body.elapsed_total_ms).toBe(9000);
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'undo' })).status).toBe(409);
    const contents = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
    expect(contents).not.toContain('private');
    const rows = contents.trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map((row: any) => row.kind)).toEqual(['session', 'event', 'event', 'event', 'event']);
    expect(rows[1]).toMatchObject({ kind: 'event', event: 'error', error_category: 'api_validation' });
    expect(rows.at(-1).elapsed_total_ms).toBe(9000);
    expect((await request(app).get('/api/research-experiments/status')).body.excludedFields).toContain('query');
    expect((await request(app).delete(`/api/research-experiments/sessions/${sid}`)).body.deleted).toBe(true);
    expect((await request(app).get('/api/research-experiments/status')).body.sessions).toBe(0);
  });

  it('allows deleting all local records and reports an empty journal', async () => {
    await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E0', taskId: 'synthetic-refind-01' });
    expect((await request(app).delete('/api/research-experiments/events')).body.deleted).toBe(true);
    expect((await request(app).get('/api/research-experiments/status')).body.sessions).toBe(0);
  });

  it('measures checking and correction spans inside phases without adding them to wall time', async () => {
    const started = await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01' });
    const sid = started.body.sid as string;
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'phase_start', phase: 'compare' })).status).toBe(201);
    clock = new Date('2026-11-05T00:00:03.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'activity_start', category: 'verification' })).status).toBe(201);
    clock = new Date('2026-11-05T00:00:05.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'activity_end', category: 'verification' })).body.duration_ms).toBe(2000);
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'activity_start', category: 'correction' })).status).toBe(201);
    clock = new Date('2026-11-05T00:00:06.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'activity_end', category: 'correction' })).body.duration_ms).toBe(1000);
    clock = new Date('2026-11-05T00:00:08.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'phase_end', phase: 'compare' })).status).toBe(201);
    clock = new Date('2026-11-05T00:00:10.000Z');
    expect((await request(app).post(`/api/research-experiments/sessions/${sid}/events`).send({ event: 'task_complete', outcome: 'success' })).body.elapsed_total_ms).toBe(10000);
    const { analyzeExperimentEvents } = await import('../quality/e0e6/analysis.mjs');
    const rows = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const metrics = analyzeExperimentEvents(rows);
    expect(metrics).toMatchObject({ success_count: 1, management_operation_count: 0, error_count: 0, elapsed_total_ms: [10000], verification_time_ms: [2000], correction_time_ms: [1000] });
    expect(metrics.accounting.subdurations_added_to_total).toBe(false);
  });

  it('rehashes remaining sessions after withdrawal, enforces retention, and accepts safe appends after deletion', async () => {
    const first = await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01' });
    const second = await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01' });
    const firstSid = first.body.sid as string;
    const secondSid = second.body.sid as string;
    expect((await request(app).delete(`/api/research-experiments/sessions/${firstSid}`)).status).toBe(200);
    expect((await request(app).post(`/api/research-experiments/sessions/${secondSid}/events`).send({ event: 'phase_start', phase: 'search' })).status).toBe(201);
    expect((await request(app).get('/api/research-experiments/status')).body.sessions).toBe(1);
    const rehashed = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
    expect(rehashed).not.toContain(firstSid);
    expect(rehashed).toContain(secondSid);

    await request(app).delete('/api/research-experiments/events');
    app = express();
    app.use(express.json());
    app.use('/api', createResearchExperimentRouter({ directory, now: () => clock, retentionDays: 1 }));
    clock = new Date('2026-11-05T00:00:00.000Z');
    const expiring = await request(app).post('/api/research-experiments/sessions').send({ consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01' });
    expect(expiring.status).toBe(201);
    clock = new Date('2026-11-06T00:00:00.000Z');
    expect((await request(app).get('/api/research-experiments/status')).body.sessions).toBe(0);
    expect(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8')).toBe('');
  });
});
