export interface CaptureDraft { text: string; clientRequestId: string; updatedAt: string; studentId?: string; scheduleId?: string; recordKind?: string; }
function keyFor(teacherId: string): string { return `teacher-platform:capture-draft:${teacherId}`; }
export function newClientRequestId(): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch { /* restricted browser */ }
  return `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function readCaptureDraft(teacherId: string): CaptureDraft | null {
  try { const raw = window.localStorage.getItem(keyFor(teacherId)); if (!raw) return null; const parsed = JSON.parse(raw) as Partial<CaptureDraft>; if (typeof parsed.text !== 'string' || typeof parsed.clientRequestId !== 'string' || typeof parsed.updatedAt !== 'string') return null; return { text: parsed.text, clientRequestId: parsed.clientRequestId, updatedAt: parsed.updatedAt, ...(safeContextValue(parsed.studentId) ? { studentId: parsed.studentId } : {}), ...(safeContextValue(parsed.scheduleId) ? { scheduleId: parsed.scheduleId } : {}), ...(safeContextValue(parsed.recordKind) ? { recordKind: parsed.recordKind } : {}) }; } catch { return null; }
}
export function writeCaptureDraft(teacherId: string, draft: CaptureDraft): void { try { window.localStorage.setItem(keyFor(teacherId), JSON.stringify(draft)); } catch { /* best effort */ } }
export function clearCaptureDraft(teacherId: string): void { try { window.localStorage.removeItem(keyFor(teacherId)); } catch { /* best effort */ } }
function safeContextValue(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
