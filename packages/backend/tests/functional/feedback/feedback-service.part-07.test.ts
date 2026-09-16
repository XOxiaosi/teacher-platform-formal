import { describe, it, expect } from 'vitest';


import { prisma, TEACHER_A, createService, fixedClock, createStatusFixture, createStudentFixture } from './feedback-service.fixtures.js';
describe("feedbackService.updateFeedbackStatus / I4b 审计时间治理", () => {


    it('createFeedback 时 createdAt/updatedAt 由 TrustedClock 写入且同源', async () => {
      const token = new Date('2031-05-06T07:08:09.123Z');
      const clock = fixedClock(token);
      const student = await createStudentFixture(TEACHER_A, '同源-学生');

      const result = await createService(clock).createFeedback({
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '同源测试',
        content: '同源内容',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.createdAt).toEqual(token);
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: result.value.id } });
      expect(db.createdAtTs).toEqual(token);
      expect(db.updatedAtTs).toEqual(token);
    });


    it('updateFeedbackContent 时 updatedAt 由 TrustedClock 写入', async () => {
      const student = await createStudentFixture(TEACHER_A, '更新-学生');
      const createResult = await createService().createFeedback({
        teacherId: TEACHER_A,
        studentId: student.id,
        title: '原标题',
        content: '原内容',
      });
      if (!createResult.ok) return;

      const token = new Date('2031-06-07T08:09:10.456Z');
      const clock = fixedClock(token);
      const result = await createService(clock).updateFeedbackContent({
        teacherId: TEACHER_A,
        feedbackId: createResult.value.id,
        title: '新标题',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toBe('新标题');
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: result.value.id } });
      expect(db.updatedAtTs).toEqual(token);
    });


    it('updateFeedbackStatus 时 sentAt 与 updatedAt 同源（同一 clock 调用）', async () => {
      const feedback = await createStatusFixture('reviewed');
      const token = new Date('2031-07-08T09:10:11.789Z');
      const clock = fixedClock(token);

      const result = await createService(clock).updateFeedbackStatus({
        teacherId: TEACHER_A,
        feedbackId: feedback.id,
        status: 'sent',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.sentAt).toEqual(token);
      expect(result.value.updatedAt).toEqual(token);
      expect(clock.now).toHaveBeenCalledTimes(1);

      const db = await prisma.parentFeedback.findUniqueOrThrow({ where: { id: feedback.id } });
      expect(db.sentAtTs).toEqual(token);
      expect(db.updatedAtTs).toEqual(token);
    });
});
