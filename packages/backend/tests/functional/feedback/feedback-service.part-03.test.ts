import { describe, it, expect } from 'vitest';

import { TEACHER_A, TEACHER_B, createService, createStudentFixture, createFeedbackOrThrow } from './feedback-service.fixtures.js';
describe("feedbackService.listFeedbacks", () => {


  it('只列出当前 teacher 的反馈，支持 studentId 与 status 过滤', async () => {
    const studentA = await createStudentFixture(TEACHER_A, '学生A');
    const studentB = await createStudentFixture(TEACHER_B, '学生B');

    const feedbackA1 = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      title: 'A draft',
      content: 'A draft content',
    });
    await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      title: 'A reviewed',
      content: 'A reviewed content',
    });
    await createFeedbackOrThrow({
      teacherId: TEACHER_B,
      studentId: studentB.id,
      title: 'B draft',
      content: 'B draft content',
    });

    await createService().updateFeedbackStatus({ teacherId: TEACHER_A, feedbackId: feedbackA1.id, status: 'reviewed' });

    const result = await createService().listFeedbacks({
      teacherId: TEACHER_A,
      studentId: studentA.id,
      status: 'reviewed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0].teacherId).toBe(TEACHER_A);
    expect(result.value.items[0].studentId).toBe(studentA.id);
    expect(result.value.items[0].status).toBe('reviewed');
  });
});
