import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLessonLedgerAdjustment, listLessonLedgerEntries, prepareLessonLedgerAdjustment } from './payments';
import type { ConfirmLessonLedgerAdjustmentResult, LessonLedgerEntryData, PrepareLessonLedgerAdjustmentResult } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('课时流水读取 API', () => {
  it('按学生查询时 URL 编码 studentId，使用 GET + session credentials，并返回真实数组', async () => {
    const entries: LessonLedgerEntryData[] = [{
      id: 'entry-1',
      teacherId: 'teacher-a',
      studentId: 'student/a?1',
      entryType: 'purchase',
      lessonDelta: 8,
      amount: 800,
      reason: null,
      paymentId: 'payment-1',
      lessonId: null,
      adjustmentConfirmationId: null,
      clientRequestId: 'payment-request-1',
      createdAt: '2030-07-24T01:00:00.000Z',
    }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: entries }),
    } as Response);

    await expect(listLessonLedgerEntries('teacher-a', { studentId: 'student/a?1' })).resolves.toEqual(entries);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/lesson-ledger/entries?studentId=student%2Fa%3F1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('未指定学生时保留集合接口默认路径', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: [] }),
    } as Response);

    await expect(listLessonLedgerEntries('teacher-a')).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/lesson-ledger/entries', expect.objectContaining({
      method: 'GET',
      credentials: 'include',
    }));
  });

  it('先以精确 payload 查看调整影响，再以 confirmation id 明确确认', async () => {
    const prepared: PrepareLessonLedgerAdjustmentResult = {
      confirmation: {
        id: 'confirmation/a?', teacherId: 'teacher-a', studentId: 'student-1', entryType: 'manual_adjustment', lessonDelta: -2,
        reason: '补录扣减', clientRequestId: 'ledger-request-1', status: 'pending', confirmedAt: null,
        createdAt: '2026-09-23T01:00:00.000Z', updatedAt: '2026-09-23T01:00:00.000Z', entry: null,
      },
      balanceBefore: { purchased: 8, attended: 1, adjustments: 0, remaining: 7 },
      balanceAfter: { purchased: 8, attended: 1, adjustments: -2, remaining: 5 },
    };
    const confirmed: ConfirmLessonLedgerAdjustmentResult = {
      confirmation: { ...prepared.confirmation, status: 'confirmed', confirmedAt: '2026-09-23T01:01:00.000Z' },
      balance: prepared.balanceAfter,
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: prepared }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: confirmed }) } as Response);
    const body = { studentId: 'student-1', entryType: 'manual_adjustment' as const, lessonDelta: -2, reason: '补录扣减', clientRequestId: 'ledger-request-1' };

    await expect(prepareLessonLedgerAdjustment('teacher-a', body)).resolves.toEqual(prepared);
    await expect(confirmLessonLedgerAdjustment('teacher-a', 'confirmation/a?')).resolves.toEqual(confirmed);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/lesson-ledger/adjustments', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/lesson-ledger/adjustments/confirmation%2Fa%3F/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    });
  });
});
