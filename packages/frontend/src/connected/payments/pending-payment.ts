import type { Payment } from '../../preview/data';

export interface PendingPaymentRequest {
  clientRequestId: string;
  payment: Payment;
}

const prefix = 'teaching-payment-request:';
const memory = new Map<string, PendingPaymentRequest>();
const key = (teacherId: string) => `${prefix}${encodeURIComponent(teacherId)}`;

function validPayment(value: unknown): value is Payment {
  if (!value || typeof value !== 'object') return false;
  const payment = value as Partial<Payment>;
  return typeof payment.id === 'string' && payment.id.length > 0
    && typeof payment.studentId === 'string' && payment.studentId.length > 0
    && typeof payment.amount === 'number' && Number.isFinite(payment.amount) && payment.amount > 0
    && typeof payment.lessons === 'number' && Number.isInteger(payment.lessons) && payment.lessons > 0
    && typeof payment.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payment.date);
}

function valid(value: unknown): value is PendingPaymentRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<PendingPaymentRequest>;
  return typeof request.clientRequestId === 'string'
    && request.clientRequestId.length > 0
    && validPayment(request.payment);
}

export function readPendingPaymentRequest(teacherId: string): PendingPaymentRequest | null {
  const id = key(teacherId);
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(id) ?? 'null');
    if (valid(stored)) {
      const request = { clientRequestId: stored.clientRequestId, payment: { ...stored.payment } };
      memory.set(id, request);
      return request;
    }
  } catch {
    // Keep the in-memory fallback when session storage is unavailable or corrupt.
  }
  const fallback = memory.get(id);
  return fallback ? { clientRequestId: fallback.clientRequestId, payment: { ...fallback.payment } } : null;
}

/** A request key stays bound to the first submitted payload until a server receipt resolves it. */
export function beginPendingPaymentRequest(teacherId: string, payment: Payment): PendingPaymentRequest {
  const existing = readPendingPaymentRequest(teacherId);
  if (existing) return existing;
  const request = { clientRequestId: crypto.randomUUID(), payment: { ...payment } };
  const id = key(teacherId);
  memory.set(id, request);
  try { sessionStorage.setItem(id, JSON.stringify(request)); } catch {
    // The mounted application can still reuse the in-memory request identity.
  }
  return { clientRequestId: request.clientRequestId, payment: { ...request.payment } };
}

export function clearPendingPaymentRequest(teacherId: string, clientRequestId: string): void {
  const current = readPendingPaymentRequest(teacherId);
  if (!current || current.clientRequestId !== clientRequestId) return;
  const id = key(teacherId);
  memory.delete(id);
  try { sessionStorage.removeItem(id); } catch {
    // A received server receipt remains authoritative when storage cannot be updated.
  }
}

export function clearPendingPaymentRequests(teacherId: string): void {
  const id = key(teacherId);
  memory.delete(id);
  try { sessionStorage.removeItem(id); } catch {
    // No accessible session storage.
  }
}
