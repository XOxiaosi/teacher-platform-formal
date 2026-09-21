import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLessonLedgerEntries } from './payments';
import type { LessonLedgerEntryData } from './types';

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
});
