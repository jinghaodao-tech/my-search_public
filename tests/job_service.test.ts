import { describe, expect, it } from 'vitest';
import { createJobService } from '../services/job_service.js';

describe('job service', () => {
  it('marks queued and running jobs as interrupted on service startup', async () => {
    const { insertJob } = await import('../repositories/jobs_repository.js');
    const now = new Date().toISOString();
    const queuedId = `restart-queued-${Date.now()}`;
    const runningId = `restart-running-${Date.now()}`;
    insertJob({ id: queuedId, type: 'test', status: 'queued', createdAt: now, updatedAt: now });
    insertJob({ id: runningId, type: 'test', status: 'running', createdAt: now, updatedAt: now });

    const service = createJobService();

    expect(service.get(queuedId)).toMatchObject({ status: 'failed', error: 'Job interrupted by process restart' });
    expect(service.get(runningId)).toMatchObject({ status: 'failed', error: 'Job interrupted by process restart' });
  });

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
