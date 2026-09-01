import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { updateStudentProfile } from './students';
import { rescheduleLesson } from './schedules';
import { updateLessonRecord } from './lessons';
import { updatePayment } from './payments';
import { updateMemo } from './memos';
import { updateFeedbackContent } from './feedback';
import type { JsonValue, ScheduleData } from './types';

const TEACHER = 'teacher-1';
const ENTITY_ID = 'id/with spaces?';
const TOKEN = '2026-08-16T10:00:00.000Z';

function mockSuccess(data: unknown = { value: { id: ENTITY_ID }, changeLogId: 'log-1' }) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

function expectedOptions(method: 'PATCH' | 'POST', body: unknown) {
  return {
    method,
    headers: {
      'content-type': 'application/json',
    },
    credentials: 'include' as const,
    body: JSON.stringify(body),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A5-I8 frontend edit clients', () => {
  it('sends all six frozen method/path/body contracts with encoded IDs', async () => {
    const fetchMock = mockSuccess();
    const studentBody = { expectedUpdatedAt: TOKEN, changes: { name: '新名字', source: null } };
    const scheduleBody = {
      expectedUpdatedAt: TOKEN,
      replacement: {
        scheduledStart: '2026-08-17T01:00:00.000Z',
        scheduledEnd: '2026-08-17T02:00:00.000Z',
      },
    };
    const lessonBody = { expectedUpdatedAt: TOKEN, changes: { homework: null } };
    const paymentBody = { expectedUpdatedAt: TOKEN, changes: { amount: 1200, note: null } };
    const memoBody = { expectedUpdatedAt: TOKEN, changes: { tags: ['重点', { done: false }] } };
    const feedbackBody = { expectedUpdatedAt: TOKEN, changes: { content: '更新内容' } };

    await updateStudentProfile(TEACHER, ENTITY_ID, studentBody);
    await rescheduleLesson(TEACHER, ENTITY_ID, scheduleBody);
    await updateLessonRecord(TEACHER, ENTITY_ID, lessonBody);
    await updatePayment(TEACHER, ENTITY_ID, paymentBody);
    await updateMemo(TEACHER, ENTITY_ID, memoBody);
    await updateFeedbackContent(TEACHER, ENTITY_ID, feedbackBody);

    const encoded = encodeURIComponent(ENTITY_ID);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/v1/students/${encoded}/profile`, expectedOptions('PATCH', studentBody));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/schedules/${encoded}/reschedule`, expectedOptions('POST', scheduleBody));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/v1/lessons/${encoded}/record`, expectedOptions('PATCH', lessonBody));
    expect(fetchMock).toHaveBeenNthCalledWith(4, `/api/v1/payments/${encoded}`, expectedOptions('PATCH', paymentBody));
    expect(fetchMock).toHaveBeenNthCalledWith(5, `/api/v1/memos/${encoded}`, expectedOptions('PATCH', memoBody));
    expect(fetchMock).toHaveBeenNthCalledWith(6, `/api/v1/feedback/${encoded}/content`, expectedOptions('PATCH', feedbackBody));
  });

  it('preserves VERSION_CONFLICT as ApiError and never retries automatically', async () => {
    const conflict = {
      code: 'VERSION_CONFLICT' as const,
      message: '记录已被其他操作更新，请刷新后重试',
      field: 'expectedUpdatedAt',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: conflict }),
    } as Response);

    const call = updatePayment(TEACHER, 'payment-1', {
      expectedUpdatedAt: TOKEN,
      changes: { note: '冲突' },
    });

    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ error: conflict });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('models JSON fields without pretending they are string arrays', () => {
    const pendingFields: JsonValue = { missing: ['studentId'], confidence: 0.4 };
    const schedule = { pendingFields } as ScheduleData;

    expect(schedule.pendingFields).toEqual(pendingFields);
  });
});
