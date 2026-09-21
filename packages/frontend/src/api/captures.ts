import { apiRequest } from './client';

export type CaptureVisibility = 'internal_only' | 'parent_shareable';

export interface CaptureCandidate {
  id: string;
  candidateType: 'verbatim_note';
  payload: { text: string };
  reviewStatus: 'pending' | 'confirmed' | 'rejected' | 'deferred';
  originalPayload?: { text: string };
  version?: number;
  confirmedRecordId?: string | null;
  confidence: null;
  visibility?: CaptureVisibility;
}

export interface CaptureTask {
  id: string;
  status: string;
  processorVersion: string;
}

export interface CaptureRecord {
  id: string;
  sourceType: 'text';
  sourceChannel: 'web';
  rawText: string;
  occurredAt: string;
  createdAt: string;
  task: CaptureTask;
  candidate: CaptureCandidate;
  candidates?: CaptureCandidate[];
  confirmedRecordId?: string | null;
}

export interface CreateCaptureResult {
  capture: CaptureRecord;
  replayed: boolean;
}

export type CaptureDeletionStatus = 'pending' | 'failed' | 'completed';

export interface CaptureDeletionReceipt {
  id: string;
  eventId: string;
  status: CaptureDeletionStatus;
  attemptCount: number;
  retryable: boolean;
  lastErrorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CaptureDeletionResult {
  receipt: CaptureDeletionReceipt;
  replayed: boolean;
}

export function createCapture(body: {
  clientRequestId: string;
  sourceType: 'text';
  text: string;
}): Promise<CreateCaptureResult> {
  return apiRequest('/captures', { method: 'POST', body });
}

export function getCapture(eventId: string): Promise<CaptureRecord> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}`, { method: 'GET' });
}

export function listCaptures(cursor?: string): Promise<{ items: CaptureRecord[]; nextCursor: string | null }> {
  return apiRequest(`/captures${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' });
}

export function editCaptureCandidate(eventId: string, candidateId: string, body: { version: number; text: string }): Promise<CaptureRecord> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}/candidates/${encodeURIComponent(candidateId)}`, { method: 'PATCH', body });
}

export function reviewCaptureCandidate(eventId: string, candidateId: string, body: { version: number; action: 'reject' | 'defer' }): Promise<CaptureRecord> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}/candidates/${encodeURIComponent(candidateId)}/review`, { method: 'POST', body });
}

export function confirmCaptureCandidate(eventId: string, candidateId: string, body: { version: number; clientRequestId: string; studentId: string; visibility: CaptureVisibility }): Promise<ConfirmCaptureResult> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}/candidates/${encodeURIComponent(candidateId)}/confirm-record`, { method: 'POST', body });
}

export function createCaptureDeletion(
  eventId: string,
  clientRequestId: string,
): Promise<CaptureDeletionResult> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}/deletions`, {
    method: 'POST',
    body: { clientRequestId },
  });
}

export function getCaptureDeletion(receiptId: string): Promise<CaptureDeletionReceipt> {
  return apiRequest(`/capture-deletions/${encodeURIComponent(receiptId)}`, { method: 'GET' });
}

export function retryCaptureDeletion(receiptId: string): Promise<CaptureDeletionResult> {
  return apiRequest(`/capture-deletions/${encodeURIComponent(receiptId)}/retry`, { method: 'POST' });
}

export interface ConfirmCaptureResult { recordId: string; studentId: string; scheduleId: string | null; visibility?: CaptureVisibility; }
export function confirmCapture(eventId: string, body: { clientRequestId: string; studentId: string; scheduleId?: string }): Promise<ConfirmCaptureResult> {
  return apiRequest(`/captures/${encodeURIComponent(eventId)}/confirm-record`, { method: 'POST', body });
}
