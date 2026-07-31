import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';

describe('jobs API', () => {
  it('returns a stable not-found error for an unknown job', async () => {
    const response = await request(app).get('/api/jobs/missing-job');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('job_not_found');
    expect(response.body.requestId).toBeTruthy();
  });

  it('accepts fixture collection as a background job', async () => {
    const accepted = await request(app)
      .post('/api/collect')
      .send({ fixture: 'portfolio-demo', background: true });
    expect(accepted.status).toBe(202);
    expect(accepted.body.jobId).toBeTruthy();

    await new Promise(resolve => setImmediate(resolve));
    const status = await request(app).get(`/api/jobs/${accepted.body.jobId}`);
    expect(status.status).toBe(200);
    expect(['running', 'succeeded']).toContain(status.body.status);
  });
});
