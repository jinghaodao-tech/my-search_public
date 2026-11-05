import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRefindStudyEvent, createRefindStudyRouter } from '../routes/refind_study_routes.js';

describe('personal refind capture export', () => {
  const privateRoot = path.join(process.cwd(), 'quality', 'e2e', 'local', 'personal-refind');
  let directory: string;
  let studyDirectory: string;
  let finalDirectory: string;
  let developmentDirectory: string;

  beforeEach(() => {
    directory = path.join(privateRoot, `capture-export-test-${randomUUID()}`);
    studyDirectory = path.join(directory, 'study');
    finalDirectory = path.join(directory, 'final');
    developmentDirectory = path.join(directory, 'development');
    fs.mkdirSync(studyDirectory, { recursive: true });
    fs.mkdirSync(developmentDirectory, { recursive: true });
    fs.writeFileSync(path.join(developmentDirectory, 'personal-dev-fixture.json'), JSON.stringify({
      id: 'personal-dev-fixture', query: 'development fixture query', goldIds: ['card-dev-fixture'], split: 'development',
    }));
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('moves one consented API session through human review into the final record format', async () => {
    fs.writeFileSync(path.join(studyDirectory, 'protocol.json'), JSON.stringify({
      study_id: 'integration-fixture', planned_n: 300, build_id: 'rolling-personal', scope: 'personal-longitudinal',
    }));
    const app = express();
    app.use(express.json());
    app.use('/api', createRefindStudyRouter({ directory: studyDirectory, root: process.cwd(), buildId: () => 'sha256:integration-build',
      getCards: () => [
        { id: 'gold-a', title: 'Synthetic target A', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 'gold-b', title: 'Synthetic target B', createdAt: '2020-01-02T00:00:00.000Z' },
      ], getCard: id => id === 'gold-a' || id === 'gold-b' ? { id, title: id, createdAt: '2020-01-01T00:00:00.000Z' } : null }));

    const started = await request(app).post('/api/refind-study/sessions').send({
      participant: 'participant_01', query: 'synthetic end-to-end refinding request', consent: true,
    });
    expect(started.status).toBe(201);
    expect((await request(app).post(`/api/refind-study/sessions/${started.body.sid}/interactions`).send({
      action: 'search_response', top10: ['gold-a'], candidateIdsBeforeRerank: ['gold-a', 'gold-b'],
      actualEngine: 'fts5-morph-saved-cards', fallbackUsed: false, httpStatus: 200, latencyMs: 42,
    })).status).toBe(201);
    expect((await request(app).post(`/api/refind-study/sessions/${started.body.sid}/adjudication`).send({
      category: 'memory', goldIds: ['gold-a', 'gold-b'], unknown: false, humanChecked: true,
    })).status).toBe(201);

    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bench/export_personal_refind_capture.mjs',
      path.relative(process.cwd(), studyDirectory), path.relative(process.cwd(), finalDirectory),
      path.relative(process.cwd(), developmentDirectory)], { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ sessions: 1, primaryEligible: 1, exported: 1 });
    const record = JSON.parse(fs.readFileSync(path.join(finalDirectory, fs.readdirSync(finalDirectory)[0]!), 'utf8'));
    expect(record).toMatchObject({ origin: 'human-natural-refind', category: 'memory', split: 'final',
      humanVerified: true, savedBeforeQuery: true, eligibility: 'eligible', goldIds: ['gold-a', 'gold-b'] });
    expect(record.observedSession).toMatchObject({ top10Ids: ['gold-a'], candidateIdsBeforeRerank: ['gold-a', 'gold-b'],
      httpStatus: 200, totalLatencyMs: 42, actualEngine: 'fts5-morph-saved-cards', fallbackUsed: false });
  });

  it('exports only human-confirmed natural memory cases and keeps timeouts as failures', () => {
    const lockTime = '2026-10-25T00:00:00.000Z';
    const makeSession = (sid: string, query: string, targetId: string) => {
      appendRefindStudyEvent(studyDirectory, 'session', {
        sid, study_id: 'fixture', participant: 'participant_01', build_id: 'sha256:fixture',
        query, top10: [], source: 'human-typed-live-local-api', consent_declared: true,
        card_ids_at_start: [targetId, 'other-card'], card_created_at_at_start: { [targetId]: lockTime, 'other-card': lockTime },
      });
      return sid;
    };
    const successSid = makeSession(randomUUID(), 'natural memory fixture', 'card-new-fixture');
    appendRefindStudyEvent(studyDirectory, 'interaction', { sid: successSid, action: 'search_response', top10: ['card-new-fixture'],
      candidate_ids_before_rerank: ['card-new-fixture', 'other-card'], http_status: 200, latency_ms: 31,
      actual_engine: 'fts5-morph-saved-cards', fallback_used: false });
    appendRefindStudyEvent(studyDirectory, 'adjudication', { sid: successSid, category: 'memory', gold_ids: ['card-new-fixture'],
      status: 'verified', reviewed_by_human: true });

    const timeoutSid = makeSession(randomUUID(), 'timeout memory fixture', 'card-timeout-fixture');
    appendRefindStudyEvent(studyDirectory, 'interaction', { sid: timeoutSid, action: 'search_response', top10: [],
      http_status: 504, error: 'timeout', latency_ms: 30_001, actual_engine: null, fallback_used: null });
    appendRefindStudyEvent(studyDirectory, 'adjudication', { sid: timeoutSid, category: 'memory', gold_ids: ['card-timeout-fixture'],
      status: 'verified', reviewed_by_human: true });

    const overlapSid = makeSession(randomUUID(), 'development overlap fixture', 'card-dev-fixture');
    appendRefindStudyEvent(studyDirectory, 'interaction', { sid: overlapSid, action: 'search_response', top10: [], http_status: 200, latency_ms: 10 });
    appendRefindStudyEvent(studyDirectory, 'adjudication', { sid: overlapSid, category: 'memory', gold_ids: ['card-dev-fixture'],
      status: 'verified', reviewed_by_human: true });

    const exactTitleSid = makeSession(randomUUID(), 'exact title fixture', 'card-exact-fixture');
    appendRefindStudyEvent(studyDirectory, 'interaction', { sid: exactTitleSid, action: 'search_response', top10: ['card-exact-fixture'], http_status: 200, latency_ms: 15 });
    appendRefindStudyEvent(studyDirectory, 'adjudication', { sid: exactTitleSid, category: 'exact-title', gold_ids: ['card-exact-fixture'],
      status: 'verified', reviewed_by_human: true });

    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bench/export_personal_refind_capture.mjs',
      path.relative(process.cwd(), studyDirectory), path.relative(process.cwd(), finalDirectory),
      path.relative(process.cwd(), developmentDirectory)], { cwd: process.cwd(), encoding: 'utf8' });
    const summary = JSON.parse(output);
    expect(summary).toMatchObject({ status: 'EXPORTED', sessions: 4, primaryEligible: 2, ineligible: 1, nonPrimary: 1, exported: 2 });

    const exported = fs.readdirSync(finalDirectory).map(name => JSON.parse(fs.readFileSync(path.join(finalDirectory, name), 'utf8')));
    const timeout = exported.find(record => record.query === 'timeout memory fixture');
    expect(timeout).toMatchObject({ origin: 'human-natural-refind', split: 'final', category: 'memory', eligibility: 'eligible' });
    expect(timeout.observedSession).toMatchObject({ httpStatus: 504, timedOut: true, top10Ids: [], totalLatencyMs: 30_001 });
    const overlap = fs.readdirSync(path.join(directory, 'capture-review', 'ineligible'))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, 'capture-review', 'ineligible', name), 'utf8')));
    expect(overlap.some(record => record.eligibilityReason.includes('開発用'))).toBe(true);
    expect(exported.some(record => record.category === 'exact-title')).toBe(false);

    const repeated = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/bench/export_personal_refind_capture.mjs',
      path.relative(process.cwd(), studyDirectory), path.relative(process.cwd(), finalDirectory),
      path.relative(process.cwd(), developmentDirectory)], { cwd: process.cwd(), encoding: 'utf8' });
    expect(JSON.parse(repeated)).toMatchObject({ primaryEligible: 2, exported: 0 });
  });
});
