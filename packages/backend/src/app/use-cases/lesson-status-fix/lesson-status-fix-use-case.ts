import type { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createPaymentService } from '../../../features/payments/index.js';
import type { LessonStatusFixInput, LessonStatusFixUseCase } from './types.js';

export function createLessonStatusFixUseCase(prisma: PrismaClient): LessonStatusFixUseCase {
  const lessons = createLessonService(prisma);
  const payments = createPaymentService(prisma);

  return {
    async fixLessonStatus(input: LessonStatusFixInput) {
      const existing = await lessons.getLesson(input.lessonId);
      if (!existing.ok) return existing;

      const updated = await lessons.updateLessonStatus({
        lessonId: input.lessonId,
        targetStatus: input.targetStatus,
      });
      if (!updated.ok) return updated;

      const purchased = await payments.sumLessonCount({ studentId: existing.value.studentId });
      if (!purchased.ok) return purchased;

      const attended = await lessons.countByStudent({
        studentId: existing.value.studentId,
        status: 'attended',
      });
      if (!attended.ok) return attended;

      return ok({
        lesson: updated.value,
        balance: {
          purchased: purchased.value,
          attended: attended.value,
          remaining: purchased.value - attended.value,
        },
      });
    },
  };
}
