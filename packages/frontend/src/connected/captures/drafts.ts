import type { CaptureVisibility } from '../../api/captures';

export interface CaptureConfirmationDraft { clientRequestId: string; studentId: string; version: number; visibility: CaptureVisibility }
export interface CaptureDraft {
  generation: string;
  text: string;
  studentId: string;
  baseVersion: number;
  visibility?: CaptureVisibility;
  pendingConfirm?: CaptureConfirmationDraft;
  confirmedRecordId?: string;
}
const prefix = 'teaching-capture-draft:';
const memory = new Map<string, CaptureDraft>();
const listeners = new Map<string, Set<(draft: CaptureDraft) => void>>();
const accountKey = (teacherId: string) => `${prefix}${encodeURIComponent(teacherId)}:`;
const key = (teacherId: string, captureId: string, candidateId: string) => `${accountKey(teacherId)}${encodeURIComponent(captureId)}:${encodeURIComponent(candidateId)}`;
function valid(value: unknown): value is CaptureDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<CaptureDraft>;
  if (typeof draft.generation !== 'string' || typeof draft.text !== 'string' || typeof draft.studentId !== 'string' || !Number.isSafeInteger(draft.baseVersion) || draft.baseVersion! < 1) return false;
  if (draft.visibility !== undefined && !['internal_only', 'parent_shareable'].includes(draft.visibility)) return false;
  if (draft.confirmedRecordId !== undefined && typeof draft.confirmedRecordId !== 'string') return false;
  const pending = draft.pendingConfirm;
  return pending === undefined || !!(pending && typeof pending.clientRequestId === 'string' && typeof pending.studentId === 'string' && Number.isSafeInteger(pending.version) && pending.version >= 1 && (pending.visibility === undefined || ['internal_only', 'parent_shareable'].includes(pending.visibility)));
}
function normalize(value: CaptureDraft): CaptureDraft {
  const visibility = value.visibility ?? 'internal_only';
  return { ...value, visibility, pendingConfirm: value.pendingConfirm ? { ...value.pendingConfirm, visibility: value.pendingConfirm.visibility ?? visibility } : undefined };
}
export function readCaptureDraft(teacherId: string, captureId: string, candidateId: string): CaptureDraft | undefined {
  const id = key(teacherId, captureId, candidateId);
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(id) ?? 'null');
    if (valid(value)) return normalize(value);
  } catch { /* Retain the current-page fallback when storage is unavailable. */ }
  const fallback = memory.get(id);
  return fallback ? normalize(fallback) : undefined;
}
export function writeCaptureDraft(teacherId: string, captureId: string, candidateId: string, draft: CaptureDraft): void {
  const id = key(teacherId, captureId, candidateId); memory.set(id, draft);
  try { sessionStorage.setItem(id, JSON.stringify(draft)); } catch { /* Memory only, never localStorage. */ }
  listeners.get(id)?.forEach(listener => listener(draft));
}
export function subscribeCaptureDraft(teacherId: string, captureId: string, candidateId: string, listener: (draft: CaptureDraft) => void): () => void {
  const id = key(teacherId, captureId, candidateId);
  const subscriptions = listeners.get(id) ?? new Set();
  subscriptions.add(listener); listeners.set(id, subscriptions);
  return () => { subscriptions.delete(listener); if (subscriptions.size === 0) listeners.delete(id); };
}
function removeWhere(matches: (id: string) => boolean) {
  for (const id of memory.keys()) if (matches(id)) memory.delete(id);
  try { for (const id of Object.keys(sessionStorage)) if (matches(id)) sessionStorage.removeItem(id); } catch { /* No accessible storage. */ }
}
/** Called by the authenticated logout path, including in-flight operation guards. */
export function clearCaptureDrafts(teacherId: string): void {
  removeWhere(id => id.startsWith(accountKey(teacherId)));
}
export function retainOnlyTeacherCaptureDrafts(teacherId: string): void {
  removeWhere(id => id.startsWith(prefix) && !id.startsWith(accountKey(teacherId)));
}
