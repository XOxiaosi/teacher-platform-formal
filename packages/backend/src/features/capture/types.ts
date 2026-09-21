import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export interface CaptureCandidateView {
  id: string; candidateType: 'verbatim_note'; payload: { text: string };
  originalPayload: { text: string }; version: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected' | 'deferred';
  confirmedRecordId: string | null;
  confirmedRecord: {
    id: string;
    studentId: string;
    reviewStatus: 'candidate' | 'confirmed' | 'rejected' | 'superseded';
    visibility: 'internal_only' | 'parent_shareable' | 'needs_review';
    updatedAt: Date;
  } | null;
  confidence: null;
}
export interface CaptureView {
  id: string; sourceType: 'text'; sourceChannel: 'web'; rawText: string;
  occurredAt: Date; createdAt: Date; task: { id: string; status: string; processorVersion: string };
  confirmedRecordId: string | null;
  /** Legacy first-candidate projection; multi-item callers must use candidates. */
  candidate: CaptureCandidateView;
  candidates: CaptureCandidateView[];
}
export interface CaptureCandidateIdentity {
  teacherId: string; eventId: string; candidateId: string; version: number;
}
export type CaptureRecordVisibility = 'internal_only' | 'parent_shareable';
export interface DeletionReceiptView {
  id: string; eventId: string; status: 'pending' | 'completed' | 'failed'; attemptCount: number;
  retryable: boolean; lastErrorCode: string | null; createdAt: Date; completedAt: Date | null;
}
export interface ConfirmedCaptureRecordView {
  eventId: string;
  candidateId: string;
  recordId: string;
  studentId: string;
  scheduleId: string | null;
  category: 'general_note' | 'lesson_observation';
  visibility: CaptureRecordVisibility;
  replayed: boolean;
}
export interface CaptureService {
  createText(input: { teacherId: string; clientRequestId: string; text: string; candidates?: { text: string }[] }): Promise<Result<{ capture: CaptureView; replayed: boolean }, CommonError>>;
  list(input: { teacherId: string; cursor?: string; limit?: number }): Promise<Result<{ items: CaptureView[]; nextCursor: string | null }, CommonError>>;
  editCandidate(input: CaptureCandidateIdentity & { text: string }): Promise<Result<CaptureView, CommonError>>;
  reviewCandidate(input: CaptureCandidateIdentity & { action: 'reject' | 'defer' }): Promise<Result<CaptureView, CommonError>>;
  get(input: { teacherId: string; eventId: string }): Promise<Result<CaptureView, CommonError>>;
  requestDeletion(input: { teacherId: string; eventId: string; clientRequestId: string }): Promise<Result<{ receipt: DeletionReceiptView; replayed: boolean }, CommonError>>;
  getDeletionReceipt(input: { teacherId: string; receiptId: string }): Promise<Result<DeletionReceiptView, CommonError>>;
  retryDeletion(input: { teacherId: string; receiptId: string }): Promise<Result<{ receipt: DeletionReceiptView; replayed: boolean }, CommonError>>;
  confirmRecord(input: { teacherId: string; eventId: string; clientRequestId: string; studentId: string; scheduleId?: string; candidateId?: string; version?: number; visibility?: CaptureRecordVisibility }): Promise<Result<ConfirmedCaptureRecordView, CommonError>>;
}
export interface CreateCaptureServiceOptions {
  prisma: PrismaClient;
  getClient?: () => Promise<PrismaClient>;
  cipher?: FieldCipher;
  /** Test-only failure seam; production must not inject an external deleter. */
  deletionExecutor?: () => Promise<void>;
}
