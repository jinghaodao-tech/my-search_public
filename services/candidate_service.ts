import {
  expireCandidate as expireCandidateRecord,
  expireReviewedCandidates as expireReviewedCandidateRecords,
  getCandidate as getCandidateRecord,
  getCandidates as getCandidateRecords,
  reviewCandidate as reviewCandidateRecord,
  saveCandidate as saveCandidateRecord,
  type CandidateStatus,
} from '../repositories/candidates_repository.js';

export type { CandidateLifecycle, CandidateStatus } from '../repositories/candidates_repository.js';
export const getCandidates = (status?: CandidateStatus) => getCandidateRecords(status);
export const getCandidate = (id: string) => getCandidateRecord(id);
export const reviewCandidate = (id: string) => reviewCandidateRecord(id);
export const saveCandidate = (id: string) => saveCandidateRecord(id);
export const expireCandidate = (id: string) => expireCandidateRecord(id);
export const expireReviewedCandidates = (days: number) => expireReviewedCandidateRecords(days);