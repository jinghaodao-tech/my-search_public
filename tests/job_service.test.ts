import { describe, expect, it } from 'vitest';
import { createJobService } from '../services/job_service.js';

describe('job service', () => {
  it('tracks successful jobs', async () => {
    const service = createJobService();
    const job = service.submit('test-success', async () => ({ ok: true }));
    expect(service.get(job.id)?.status).toBe('queued');
    await new Promise(resolve => setImmediate(resolve));
    expect(service.get(job.id)).toMatchObject({ status: 'succeeded', result: { ok: true } });
  });

  it('tracks failed jobs without rejecting the worker loop', async () => {
    const service = createJobService();
    const job = service.submit('test-failure', async () => { throw new Error('expected failure'); });
    await new Promise(resolve => setImmediate(resolve));
    expect(service.get(job.id)).toMatchObject({ status: 'failed', error: 'expected failure' });
  });
});
