import { randomUUID } from 'node:crypto';
import { errorMeta, logger } from '../utils/logger.js';
import { getJob as getPersistedJob, insertJob, listJobs as listPersistedJobs, markInterruptedJobs, updateJob } from '../repositories/jobs_repository.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface Job<T = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: T;
  error?: string;
}

export function createJobService() {
  const interruptedJobs = markInterruptedJobs();
  if (interruptedJobs > 0) {
    logger.warn({ event: 'jobs_recovered_after_restart', interruptedJobs }, 'marked unfinished jobs as failed after process restart');
  }

  function submit<T>(type: string, handler: () => Promise<T>) {
    const now = new Date().toISOString();
    const job: Job<T> = { id: randomUUID(), type, status: 'queued', createdAt: now, updatedAt: now };
    insertJob(job);
    queueMicrotask(async () => {
      job.status = 'running';
      job.updatedAt = new Date().toISOString();
      updateJob(job);
      try {
        job.result = await handler();
        job.status = 'succeeded';
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Job failed';
        logger.error({ event: 'job_failed', jobId: job.id, jobType: type, error: errorMeta(error) }, 'background job failed');
      } finally {
        job.updatedAt = new Date().toISOString();
        updateJob(job);
      }
    });
    return job;
  }

  return {
    submit,
    get: (id: string) => getPersistedJob(id),
    list: () => listPersistedJobs(),
  };
}
