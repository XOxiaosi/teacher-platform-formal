import { describe, it, expect } from 'vitest';

import { TEACHER_A, TEACHER_B, createService, createStatusFixture, createStudentFixture, createFeedbackOrThrow } from './feedback-service.fixtures.js';
describe("feedbackService.updateFeedbackContent", () => {


  it('更新 title/content，返回更新后的反馈', async () => {
    const student = await createStudentFixture(TEACHER_A, '钱七');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '原标题',
      content: '原内容',
    });

    const result = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      title: '新标题',
      content: '新内容',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('新标题');
    expect(result.value.content).toBe('新内容');
  });


  it.each(['sent', 'archived'] as const)('%s 后拒绝内容编辑，避免出站审核投影过期', async (status) => {
    const feedback = await createStatusFixture(status, status === 'sent' ? new Date('2030-01-01T00:00:00Z') : null);
    const result = await createService().updateFeedbackContent({
      teacherId: TEACHER_A, feedbackId: feedback.id, title: '终态后修改',
    });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'status' }) });
  });


  it('空 title/content、无更新字段、不存在或跨 teacher 返回对应错误', async () => {
    const student = await createStudentFixture(TEACHER_A, '孙八');
    const feedback = await createFeedbackOrThrow({
      teacherId: TEACHER_A,
      studentId: student.id,
      title: '原标题',
      content: '原内容',
    });

    const emptyTitle = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      title: '',
    });
    expect(emptyTitle.ok).toBe(false);
    if (emptyTitle.ok) return;
    expect(emptyTitle.error.code).toBe('VALIDATION_ERROR');
    expect(emptyTitle.error.field).toBe('title');

    const emptyContent = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: feedback.id,
      content: '',
    });
    expect(emptyContent.ok).toBe(false);
    if (emptyContent.ok) return;
    expect(emptyContent.error.code).toBe('VALIDATION_ERROR');
    expect(emptyContent.error.field).toBe('content');

    const noFields = await createService().updateFeedbackContent({ teacherId: TEACHER_A, feedbackId: feedback.id });
    expect(noFields.ok).toBe(false);
    if (noFields.ok) return;
    expect(noFields.error.code).toBe('VALIDATION_ERROR');

    const missing = await createService().updateFeedbackContent({
      teacherId: TEACHER_A,
      feedbackId: 'nonexistent-id',
      title: '新标题',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('NOT_FOUND');

    const crossed = await createService().updateFeedbackContent({
      teacherId: TEACHER_B,
      feedbackId: feedback.id,
      title: '跨老师修改',
    });
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.error.code).toBe('NOT_FOUND');
  });
});
