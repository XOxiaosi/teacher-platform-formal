import type { PrismaClient } from '@prisma/client';
import { ok, err, validationError } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import type { LessonData } from '../../../features/lessons/index.js';
import type { LessonReminderInput, LessonReminderUseCase } from './types.js';

export function createLessonReminderUseCase(prisma: PrismaClient): LessonReminderUseCase {
  const lessons = createLessonService(prisma);

  return {
    async runLessonReminder(input: LessonReminderInput) {
      if (input.overdueMinutes <= 0) {
        return err(validationError('超时时长必须大于 0', 'overdueMinutes'));
      }

      const cutoff = new Date(input.now.getTime() - input.overdueMinutes * 60 * 1000);
      const pending = await lessons.listLessons({
        teacherId: input.teacherId,
        status: 'pending',
        dateTo: cutoff,
        pageSize: 1000,
      });
      if (!pending.ok) return pending;

      const updated: LessonData[] = [];
      for (const lesson of pending.value.items) {
        const result = await lessons.updateLessonStatus({
          lessonId: lesson.id,
          targetStatus: 'attended',
        });
        if (!result.ok) return result;
        updated.push(result.value);
      }

      return ok({ cutoff, updatedCount: updated.length, updatedLessons: updated });
    },
  };
}
