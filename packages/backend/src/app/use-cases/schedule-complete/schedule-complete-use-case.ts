import { err, internalError, notFound, ok, validationError } from '@teacher-platform/contracts';
import type {
  ScheduleCompleteOutput,
  ScheduleCompleteServices,
  ScheduleCompleteUseCase,
} from './types.js';

const AUDIT_FAILURE_MESSAGE = '完成日程审计写入失败';

export function createScheduleCompleteUseCaseWithServices(
  services: ScheduleCompleteServices,
): ScheduleCompleteUseCase {
  return {
    async completeSchedule(input) {
      return services.transaction<ScheduleCompleteOutput>(async (tx) => {
        const schedule = await tx.scheduling.getSchedule(input.scheduleId);
        if (!schedule.ok) return schedule;
        if (schedule.value.teacherId !== input.teacherId) {
          return err(notFound('日程不存在'));
        }

        if (!schedule.value.studentId) {
          return err(validationError('无学生的日程不能创建课次', 'studentId'));
        }

        const completed = await tx.scheduling.updateScheduleStatus({
          scheduleId: input.scheduleId,
          targetStatus: 'completed',
        });
        if (!completed.ok) return completed;

        const lesson = await tx.lessons.createLesson({
          teacherId: schedule.value.teacherId,
          studentId: schedule.value.studentId,
          scheduleId: schedule.value.id,
          date: schedule.value.scheduledStart,
          status: input.lessonStatus ?? 'attended',
        });
        if (!lesson.ok) return lesson;

        const scheduleAudit = await tx.changelog.recordChange({
          teacherId: input.teacherId,
          module: 'scheduling',
          action: 'update',
          targetType: 'Schedule',
          targetId: completed.value.id,
          before: toScheduleAuditData(schedule.value),
          after: toScheduleAuditData(completed.value),
          source: 'system',
        });
        if (!scheduleAudit.ok) return err(internalError(AUDIT_FAILURE_MESSAGE));

        const lessonAudit = await tx.changelog.recordChange({
          teacherId: input.teacherId,
          module: 'lessons',
          action: 'create',
          targetType: 'Lesson',
          targetId: lesson.value.id,
          before: null,
          after: toLessonAuditData(lesson.value),
          source: 'system',
        });
        if (!lessonAudit.ok) return err(internalError(AUDIT_FAILURE_MESSAGE));

        return ok({ schedule: completed.value, lesson: lesson.value });
      });
    },
  };
}

function toScheduleAuditData(schedule: ScheduleCompleteOutput['schedule']) {
  return {
    id: schedule.id,
    teacherId: schedule.teacherId,
    studentId: schedule.studentId,
    type: schedule.type,
    title: schedule.title,
    scheduledStartTs: schedule.scheduledStart,
    scheduledEndTs: schedule.scheduledEnd,
    status: schedule.status,
    confidence: schedule.confidence,
    pendingFields: schedule.pendingFields,
    sourceInput: schedule.sourceInput,
    parentId: schedule.parentId,
    createdAtTs: schedule.createdAt,
    updatedAtTs: schedule.updatedAt,
  };
}

function toLessonAuditData(lesson: ScheduleCompleteOutput['lesson']) {
  return {
    id: lesson.id,
    teacherId: lesson.teacherId,
    studentId: lesson.studentId,
    scheduleId: lesson.scheduleId,
    dateTs: lesson.date,
    status: lesson.status,
    progress: lesson.progress,
    studentState: lesson.studentState,
    homework: lesson.homework,
    teacherNote: lesson.teacherNote,
    sourceNoteId: lesson.sourceNoteId,
    createdAtTs: lesson.createdAt,
    updatedAtTs: lesson.updatedAt,
  };
}
