import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudent, getStudentBalance } from './students';
import { createSchedule, completeSchedule } from './schedules';
import { createPayment } from './payments';
import { assembleDailyReview } from './daily-review';
import { saveRawInput } from './ai-input';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSuccess(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, data }),
  } as Response);
}

describe('业务 API 模块', () => {
  it('students 模块使用正确路径', async () => {
    const fetchMock = mockSuccess({ id: 'student-1' });

    await createStudent('demo-teacher', { name: '张三', grade: '高三' });
    await getStudentBalance('demo-teacher', 'student-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/students', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/students/student-1/balance', expect.objectContaining({ method: 'GET' }));
  });

  it('schedules 模块使用正确路径', async () => {
    const fetchMock = mockSuccess({ id: 'schedule-1' });

    await createSchedule('demo-teacher', {
      clientRequestId: 'schedule-test-0001',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '线上',
      classFormat: 'one_to_one',
      scheduledStart: '2025-05-02T19:00:00+08:00',
      scheduledEnd: '2025-05-02T20:30:00+08:00',
    });
    await completeSchedule('demo-teacher', 'schedule-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/schedules', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/schedules/schedule-1/complete', expect.objectContaining({ method: 'POST' }));
  });

  it('payments、daily-review、ai-input 模块使用正确路径', async () => {
    const fetchMock = mockSuccess({ ok: 'data' });

    await createPayment('demo-teacher', {
      clientRequestId: 'payment-test-0001',
      studentId: 'student-1',
      amount: 3000,
      lessonCount: 10,
      paidAt: '2025-05-01T10:00:00+08:00',
    });
    await assembleDailyReview('demo-teacher', {});
    await saveRawInput('demo-teacher', { inputType: 'text', text: '张三今天讲了重点题型' });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/payments', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ clientRequestId: 'payment-test-0001', studentId: 'student-1', amount: 3000,
        lessonCount: 10, paidAt: '2025-05-01T10:00:00+08:00' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/daily-review/assemble', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/ai/raw-input', expect.objectContaining({ method: 'POST' }));
  });
});
