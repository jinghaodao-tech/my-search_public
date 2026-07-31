import { db } from '../db/database.js';

export type CandidateStatus = 'unreviewed' | 'reviewed_not_saved' | 'saved_as_card' | 'expired';
export interface CandidateLifecycle {
  candidateId: string;
  status: CandidateStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  reviewedAt?: string;
  savedAt?: string;
  expiredAt?: string;
  sourceArticleId: string;
  title: string;
  body: string;
  summary?: string;
  url: string;
  source?: string;
  publishedAt?: string;
  tags: string[];
  score?: number;
  matchReason?: string;
}
type CandidateRow = { id: string; candidate_status: CandidateStatus; first_seen_at: string | null; updated_at: string; reviewed_at: string | null; saved_at: string | null; expired_at: string | null; last_fetched_at: string | null; title: string; body: string; summary: string | null; url: string; source: string | null; published_at: string | null; tags_json: string; candidate_score: number | null; candidate_match_reason: string | null };
function toCandidate(row: CandidateRow): CandidateLifecycle {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags_json || '[]'); } catch { tags = []; }
  return { score: row.candidate_score ?? undefined, matchReason: row.candidate_match_reason ?? undefined, candidateId: row.id, status: row.candidate_status, firstSeenAt: row.first_seen_at ?? row.updated_at, lastSeenAt: row.last_fetched_at ?? row.updated_at, reviewedAt: row.reviewed_at ?? undefined, savedAt: row.saved_at ?? undefined, expiredAt: row.expired_at ?? undefined, sourceArticleId: row.id, title: row.title, body: row.body, summary: row.summary ?? undefined, url: row.url, source: row.source ?? undefined, publishedAt: row.published_at ?? undefined, tags };
}
const select = `SELECT id, candidate_status, first_seen_at, updated_at, reviewed_at, saved_at, expired_at, last_fetched_at, title, body, summary, url, source, published_at, tags_json, candidate_score, candidate_match_reason FROM articles`;
export function getCandidates(status?: CandidateStatus): CandidateLifecycle[] {
  const rows = (status ? db.prepare(`${select} WHERE candidate_status = ? ORDER BY first_seen_at DESC`).all(status) : db.prepare(`${select} ORDER BY first_seen_at DESC`).all()) as CandidateRow[];
  return rows.map(toCandidate);
}
export function getCandidate(id: string): CandidateLifecycle | null {
  const row = db.prepare(`${select} WHERE id = ?`).get(id) as CandidateRow | undefined;
  return row ? toCandidate(row) : null;
}
function setStatus(id: string, status: CandidateStatus, field: 'reviewed_at' | 'saved_at' | 'expired_at'): CandidateLifecycle | null {
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE articles SET candidate_status = ?, ${field} = ?, updated_at = ? WHERE id = ?`).run(status, now, now, id);
  return result.changes ? getCandidate(id) : null;
}
export function reviewCandidate(id: string): CandidateLifecycle | null {
  const current = getCandidate(id);
  if (!current || current.status === 'saved_as_card' || current.status === 'expired') return current;
  return setStatus(id, 'reviewed_not_saved', 'reviewed_at');
}
export function saveCandidate(id: string): CandidateLifecycle | null { return setStatus(id, 'saved_as_card', 'saved_at'); }
export function expireCandidate(id: string): CandidateLifecycle | null {
  const current = getCandidate(id);
  if (!current || current.status === 'saved_as_card') return current;
  return setStatus(id, 'expired', 'expired_at');
}
export function expireReviewedCandidates(retentionDays: number): string[] {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT id FROM articles WHERE candidate_status = 'reviewed_not_saved' AND COALESCE(reviewed_at, updated_at) < ?`).all(cutoff) as Array<{ id: string }>;
  const expire = db.prepare(`UPDATE articles SET candidate_status = 'expired', expired_at = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  return db.transaction(() => rows.map(({ id }) => { expire.run(now, now, id); return id; }))();
}