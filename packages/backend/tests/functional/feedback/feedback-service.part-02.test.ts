import { describe, it, expect } from 'vitest';

import { TEACHER_A, TEACHER_B, createService, createStudentFixture, createFeedbackOrThrow } from './feedback-service.fixtures.js';
describe("feedbackService.getFeedback", () => {


  it('按 teacherId + feedbackId 查询自己的反馈', async () => {
    const student = await createStudentFixture(TEACHER_A, '王五');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '查询反馈',
      content: '查询内容',
    });

    const result = await createService().getFeedback({ teacherId: TEACHER_A, feedbackId: feedback.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(feedback.id);
    expect(result.value.title).toBe('查询反馈');
  });


  it('不存在或跨 teacher 查询返回 NOT_FOUND', async () => {
    const student = await createStudentFixture(TEACHER_A, '赵六');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: 'A 的反馈',
      content: 'A 的内容',
    });

    const missing = await createService().getFeedback({ teacherId: TEACHER_A, feedbackId: 'nonexistent-id' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await createService().getFeedback({ teacherId: TEACHER_B, feedbackId: feedback.id });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});
