import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginPendingPaymentRequest,
  clearPendingPaymentRequest,
  clearPendingPaymentRequests,
  readPendingPaymentRequest,
} from './pending-payment';

const payment = {
  id: 'payment-operation-1',
  studentId: 'student-a',
  amount: 200,
  lessons: 2,
  date: '2026-09-22',
};

beforeEach(() => {
  clearPendingPaymentRequests('teacher-a');
  clearPendingPaymentRequests('teacher-b');
});

describe('pending payment request recovery', () => {
  it('keeps one request key bound to the first submitted payload until its receipt arrives', () => {
    const first = beginPendingPaymentRequest('teacher-a', payment);
    const changed = beginPendingPaymentRequest('teacher-a', { ...payment, amount: 300 });

    expect(changed).toEqual(first);
    expect(readPendingPaymentRequest('teacher-a')).toEqual(first);
    clearPendingPaymentRequest('teacher-a', 'a-different-request');
    expect(readPendingPaymentRequest('teacher-a')).toEqual(first);
    clearPendingPaymentRequest('teacher-a', first.clientRequestId);
    expect(readPendingPaymentRequest('teacher-a')).toBeNull();
  });

  it('isolates recovery records by teacher without destroying another account retry identity', () => {
    const teacherA = beginPendingPaymentRequest('teacher-a', payment);
    const teacherB = beginPendingPaymentRequest('teacher-b', { ...payment, id: 'payment-operation-2', studentId: 'student-b' });

    clearPendingPaymentRequest('teacher-b', teacherA.clientRequestId);

    expect(readPendingPaymentRequest('teacher-a')).toEqual(teacherA);
    expect(readPendingPaymentRequest('teacher-b')).toEqual(teacherB);
  });

  it('ignores a corrupt stored record and replaces it with a valid request', () => {
    sessionStorage.setItem('teaching-payment-request:teacher-a', '{bad-json');

    const request = beginPendingPaymentRequest('teacher-a', payment);

    expect(request.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readPendingPaymentRequest('teacher-a')).toEqual(request);
  });
});
