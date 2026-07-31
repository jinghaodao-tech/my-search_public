import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';

const originalApiKey = process.env.API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = originalApiKey;
});

describe('optional API key guard', () => {
  it('protects API routes when API_KEY is configured', async () => {
    process.env.API_KEY = 'test-api-key';
    const unauthorized = await request(app).get('/api/jobs/missing-job');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.code).toBe('authentication_required');

    const authorized = await request(app).get('/api/jobs/missing-job').set('X-API-Key', 'test-api-key');
    expect(authorized.status).toBe(404);
    expect(authorized.body.code).toBe('job_not_found');
  });
});
