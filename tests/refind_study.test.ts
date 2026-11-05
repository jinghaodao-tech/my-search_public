import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRefindStudyRouter, isLoopbackAddress } from '../routes/refind_study_routes.js';

describe('prospective local refind study API', () => {
  let directory: string;
  let app: express.Express;
  const cards = [
    { id: 'card_before', title: 'Saved SQLite note', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'card_other', title: 'Other note', createdAt: '2026-01-02T00:00:00.000Z' },
  ];

  beforeEach(() => {
    const local = path.join(process.cwd(), 'quality', 'e2e', 'local');
    fs.mkdirSync(local, { recursive: true });
    directory = fs.mkdtempSync(path.join(local, 'study-route-'));
    app = express();
    app.use(express.json());
    app.use('/api', createRefindStudyRouter({ directory, root: process.cwd(), buildId: () => 'sha256:test-build',
      getCards: () => cards, getCard: id => cards.find(card => card.id === id) ?? null }));
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('does not collect without a matching preregistration and explicit consent', async () => {
    expect((await request(app).get('/api/refind-study/status')).body.available).toBe(false);
    expect((await request(app).post('/api/refind-study/sessions').send({ participant: 'participant_01', query: 'SQLite', consent: true })).status).toBe(409);
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'study-test', planned_n: 5,
      build_id: 'sha256:test-build', scope: 'multi-user' }));
    expect((await request(app).post('/api/refind-study/sessions').send({ participant: 'participant_01', query: 'SQLite', consent: false })).status).toBe(400);
  });

  it('captures the first response, actual target opening, and human adjudication in a verifiable local journal', async () => {
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'study-test', planned_n: 5,
      build_id: 'sha256:test-build', scope: 'multi-user' }));
    const started = await request(app).post('/api/refind-study/sessions').send({
      participant: 'participant_01', query: 'SQLite lock\u2028WAL', consent: true,
    });
    expect(started.status).toBe(201);
    const sid = started.body.sid;
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/interactions`).send({
      action: 'search_response', top10: ['not-in-starting-corpus'], httpStatus: 200,
    })).status).toBe(400);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/interactions`).send({
      action: 'search_response', top10: ['card_before', 'card_before'], httpStatus: 200,
    })).status).toBe(400);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/interactions`).send({
      action: 'search_response', top10: ['card_before'], candidateIdsBeforeRerank: ['not-in-starting-corpus'], httpStatus: 200,
    })).status).toBe(400);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/interactions`).send({
      action: 'search_response', top10: ['card_before'], httpStatus: 200, latencyMs: 42,
    })).status).toBe(201);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/interactions`).send({ action: 'opened', cardId: 'card_before' })).status).toBe(201);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/adjudication`).send({
      category: 'memory', goldIds: ['card_before', 'card_other'], unknown: false, humanChecked: true,
    })).status).toBe(201);
    expect((await request(app).get('/api/refind-study/status')).body.collected).toBe(1);
    const lines = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(lines.map(event => event.kind)).toEqual(['session', 'interaction', 'interaction', 'adjudication']);
    expect(lines[0].query).toBe('SQLite lock\u2028WAL');
    expect(lines[0].card_ids_at_start).toEqual(['card_before', 'card_other']);
    expect(lines[3]).toMatchObject({ category: 'memory', gold_id: 'card_before', gold_ids: ['card_before', 'card_other'],
      opened_card_id: 'card_before', query_count: 1, reviewed_by_human: true });
    expect(lines[0].card_created_at_at_start).toMatchObject({ card_before: cards[0].createdAt, card_other: cards[1].createdAt });
  });

  it('keeps the opt-in personal cohort available across code changes and records each build', async () => {
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'personal-study', planned_n: 100,
      build_id: 'rolling-personal', scope: 'personal-longitudinal' }));
    const status = await request(app).get('/api/refind-study/status');
    expect(status.body).toMatchObject({ available: true, buildMatches: true, scope: 'personal-longitudinal', plannedN: 100 });
    const started = await request(app).post('/api/refind-study/sessions').send({
      participant: 'participant_01', query: 'natural memory query', consent: true,
    });
    expect(started.status).toBe(201);
    const session = JSON.parse(fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n')[0]!);
    expect(session.build_id).toBe('sha256:test-build');
    expect(session.card_ids_at_start).toEqual(['card_before', 'card_other']);
  });

  it('distinguishes title searches, non-refinding searches, and unresolved labels', async () => {
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'study-test', planned_n: 5,
      build_id: 'sha256:test-build', scope: 'single-user' }));
    const sid = (await request(app).post('/api/refind-study/sessions').send({
      participant: 'participant_01', query: 'article title', consent: true,
    })).body.sid;
    const invalid = await request(app).post(`/api/refind-study/sessions/${sid}/adjudication`).send({
      category: 'memory', goldIds: [], unknown: false, humanChecked: true,
    });
    expect(invalid.status).toBe(400);
    const exactTitle = await request(app).post(`/api/refind-study/sessions/${sid}/adjudication`).send({
      category: 'exact-title', goldIds: ['card_before'], unknown: false, humanChecked: true,
    });
    expect(exactTitle.status).toBe(201);
    const events = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ category: 'exact-title', gold_ids: ['card_before'], status: 'verified' });
  });

  it('rejects target IDs absent at search start and duplicate multi-user participants', async () => {
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'study-test', planned_n: 5,
      build_id: 'sha256:test-build', scope: 'multi-user' }));
    const body = { participant: 'participant_01', query: 'SQLite', consent: true };
    const sid = (await request(app).post('/api/refind-study/sessions').send(body)).body.sid;
    expect((await request(app).post('/api/refind-study/sessions').send(body)).status).toBe(409);
    expect((await request(app).post(`/api/refind-study/sessions/${sid}/adjudication`).send({
      goldId: 'new_card', unknown: false, humanChecked: true,
    })).body.error).toBe('target_not_present_before_search');
  });

  it('withdraws by removing raw records while retaining attempt history', async () => {
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'study-test', attempt: 1, planned_n: 5,
      build_id: 'sha256:test-build', scope: 'multi-user' }));
    fs.writeFileSync(path.join(directory, 'registry.json'), JSON.stringify({ attempts: [] }));
    await request(app).post('/api/refind-study/sessions').send({ participant: 'participant_01', query: 'private query', consent: true });
    expect((await request(app).delete('/api/refind-study')).body.deleted).toBe(true);
    expect(fs.existsSync(path.join(directory, 'events.jsonl'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8')).attempts[0].status).toBe('WITHDRAWN_INCOMPLETE');
  });

  it('withdrawal deletes only files exported from captured sessions, even with a damaged journal', async () => {
    const localRoot = path.join(process.cwd(), 'quality', 'e2e', 'local');
    const withdrawalRoot = fs.mkdtempSync(path.join(localRoot, 'capture-withdrawal-'));
    const personalRoot = path.join(withdrawalRoot, 'personal-refind');
    const studyDirectory = path.join(personalRoot, 'study');
    const finalDirectory = path.join(personalRoot, 'final');
    const reviewDirectory = path.join(personalRoot, 'capture-review', 'ineligible');
    try {
      fs.mkdirSync(studyDirectory, { recursive: true });
      fs.mkdirSync(finalDirectory, { recursive: true });
      fs.mkdirSync(reviewDirectory, { recursive: true });
      fs.writeFileSync(path.join(studyDirectory, 'protocol.json'), JSON.stringify({ study_id: 'withdraw-test', attempt: 1,
        planned_n: 5, build_id: 'sha256:test-build', scope: 'personal-longitudinal' }));
      const testApp = express();
      testApp.use(express.json());
      testApp.use('/api', createRefindStudyRouter({ directory: studyDirectory, root: process.cwd(), buildId: () => 'sha256:test-build',
        getCards: () => cards, getCard: id => cards.find(card => card.id === id) ?? null }));
      const started = await request(testApp).post('/api/refind-study/sessions').send({
        participant: 'participant_01', query: 'withdrawal fixture', consent: true,
      });
      const captured = path.join(finalDirectory, `personal-final-${started.body.sid}.json`);
      const reviewed = path.join(reviewDirectory, `personal-final-${started.body.sid}.json`);
      const unrelated = path.join(finalDirectory, 'personal-final-unrelated.json');
      fs.writeFileSync(captured, '{}'); fs.writeFileSync(reviewed, '{}'); fs.writeFileSync(unrelated, '{}');
      fs.appendFileSync(path.join(studyDirectory, 'events.jsonl'), '{damaged journal line}\n');

      const deleted = await request(testApp).delete('/api/refind-study');
      expect(deleted.body.deleted).toBe(true);
      expect(fs.existsSync(captured)).toBe(false);
      expect(fs.existsSync(reviewed)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally { fs.rmSync(withdrawalRoot, { recursive: true, force: true }); }
  });

  it('preserves previously archived cohorts when the current cohort is withdrawn', async () => {
    const archiveDir = path.join(path.dirname(directory), 'study_archive', 'prior-cohort');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivedResult = path.join(archiveDir, 'final.json');
    fs.writeFileSync(archivedResult, '{"status":"NOT_CERTIFIED"}');

    const response = await request(app).delete('/api/refind-study');

    expect(response.status).toBe(200);
    expect(fs.existsSync(archivedResult)).toBe(true);
    fs.rmSync(archiveDir, { recursive: true, force: true });
  });

  it('automatically deletes expired raw study data while retaining a non-identifying expiry record', async () => {
    const now = new Date('2026-10-21T00:00:00.000Z');
    fs.writeFileSync(path.join(directory, 'protocol.json'), JSON.stringify({ study_id: 'expired-study', attempt: 2,
      planned_n: 5, build_id: 'sha256:test-build', scope: 'multi-user', expires_utc: '2026-10-20T00:00:00.000Z' }));
    fs.writeFileSync(path.join(directory, 'events.jsonl'), '{"query":"private query"}\n');
    app = express();
    app.use(express.json());
    app.use('/api', createRefindStudyRouter({ directory, root: process.cwd(), now: () => now, buildId: () => 'sha256:test-build',
      getCards: () => cards, getCard: id => cards.find(card => card.id === id) ?? null }));

    const status = await request(app).get('/api/refind-study/status');
    expect(status.body).toMatchObject({ available: false, preregistered: false, expiredByRetention: true });
    expect(fs.existsSync(path.join(directory, 'events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'protocol.json'))).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8')).not.toContain('private query');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8')).attempts[0].status).toBe('EXPIRED_BY_RETENTION');
  });

  it('expires archived cohorts on a local study request', async () => {
    const archiveRoot = path.join(process.cwd(), 'quality', 'e2e', 'study_archive');
    const archiveDir = path.join(archiveRoot, `retention-test-${randomUUID()}`);
    fs.mkdirSync(archiveDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(archiveDir, 'protocol.json'), JSON.stringify({ study_id: 'expired-archive', attempt: 3,
        expires_utc: '2026-10-20T00:00:00.000Z' }));
      fs.writeFileSync(path.join(archiveDir, 'events.jsonl'), '{"query":"archived private query"}\n');
      app = express();
      app.use(express.json());
      app.use('/api', createRefindStudyRouter({ directory, root: process.cwd(), now: () => new Date('2026-10-21T00:00:00.000Z'),
        buildId: () => 'sha256:test-build', getCards: () => cards, getCard: id => cards.find(card => card.id === id) ?? null }));
      await request(app).get('/api/refind-study/status');
      expect(fs.existsSync(archiveDir)).toBe(false);
      const registry = JSON.parse(fs.readFileSync(path.join(directory, 'registry.json'), 'utf8'));
      expect(registry.attempts[0]).toMatchObject({ study_id: 'expired-archive', status: 'EXPIRED_BY_RETENTION' });
      expect(JSON.stringify(registry)).not.toContain('archived private query');
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it('accepts only loopback socket addresses, not caller-supplied forwarding headers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('203.0.113.4')).toBe(false);
  });
});
