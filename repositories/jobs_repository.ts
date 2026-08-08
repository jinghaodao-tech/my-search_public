import { db } from '../db/database.js';

export type PersistedJob = {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
};

function fromRow(row: any): PersistedJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function insertJob(job: PersistedJob) {
  db.prepare('INSERT INTO jobs (id, type, status, created_at, updated_at, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)').run(job.id, job.type, job.status, job.createdAt, job.updatedAt, job.result === undefined ? null : JSON.stringify(job.result), job.error ?? null);
}

export function updateJob(job: PersistedJob) {
  db.prepare('UPDATE jobs SET status = ?, updated_at = ?, result_json = ?, error = ? WHERE id = ?').run(job.status, job.updatedAt, job.result === undefined ? null : JSON.stringify(job.result), job.error ?? null, job.id);
}

export function getJob(id: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

export function listJobs() {
  return (db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as any[]).map(fromRow);
}

export function markInterruptedJobs(now = new Date().toISOString()): number {
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'failed', updated_at = ?, error = COALESCE(error, ?)
    WHERE status IN ('queued', 'running')
  `).run(now, 'Job interrupted by process restart');
  return result.changes;
}
