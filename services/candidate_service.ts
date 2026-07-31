import {
  expireCandidate as expireCandidateRecord,
  expireReviewedCandidates as expireReviewedCandidateRecords,
  getCandidate as getCandidateRecord,
  getCandidates as getCandidateRecords,
  reviewCandidate as reviewCandidateRecord,
  saveCandidate as saveCandidateRecord,
  type CandidateStatus,
} from '../repositories/candidates_repository.js';

export class CandidateSaveConflict extends Error {
  code = 'candidate_save_conflict' as const;
  constructor() { super('Candidate save conflict'); this.name = 'CandidateSaveConflict'; }
}

export type { CandidateLifecycle, CandidateStatus } from '../repositories/candidates_repository.js';
export const getCandidates = (status?: CandidateStatus) => getCandidateRecords(status);
export const getCandidate = (id: string) => getCandidateRecord(id);
export const reviewCandidate = (id: string) => reviewCandidateRecord(id);
export const saveCandidate = (id: string, savedCardId: string) => saveCandidateRecord(id, savedCardId);
export const expireCandidate = (id: string) => expireCandidateRecord(id);
export const expireReviewedCandidates = (days: number) => expireReviewedCandidateRecords(days);