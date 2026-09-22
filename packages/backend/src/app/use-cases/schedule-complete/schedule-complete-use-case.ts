import { err, internalError, ok, validationError } from '@teacher-platform/contracts';
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
        const schedule = await tx.scheduling.getOwnedSchedule({ teacherId: input.teacherId, scheduleId: input.scheduleId });
        if (!schedule.ok) return schedule;

        const participantIds = schedule.value.participantIds.length > 0
          ? schedule.value.participantIds
          : (schedule.value.studentId ? [schedule.value.studentId] : []);
        if (participantIds.length === 0) {
          return err(validationError('无学生的日程不能创建课次', 'studentId'));
        }
        if (schedule.value.status === 'completed') {
          const existingLessons = await tx.lessons.listLessonsForSchedule({ teacherId: input.teacherId, scheduleId: schedule.value.id });
          if (!existingLessons.ok) return existingLessons;
          if (existingLessons.value.length !== participantIds.length) return err(validationError('已完成日程的课次不完整', 'scheduleId'));
          return ok({ schedule: schedule.value, lesson: existingLessons.value[0], lessons: existingLessons.value });
        }

        const completed = await tx.scheduling.updateScheduleStatus({
          teacherId: input.teacherId,
          scheduleId: input.scheduleId,
          targetStatus: 'completed',
        });
        if (!completed.ok) {
          if (completed.error.code !== 'VERSION_CONFLICT') return completed;
          const replay = await tx.scheduling.getOwnedSchedule({ teacherId: input.teacherId, scheduleId: input.scheduleId });
          if (!replay.ok || replay.value.status !== 'completed') return completed;
          const existingLessons = await tx.lessons.listLessonsForSchedule({ teacherId: input.teacherId, scheduleId: input.scheduleId });
          if (!existingLessons.ok || existingLessons.value.length !== participantIds.length) return completed;
          return ok({ schedule: replay.value, lesson: existingLessons.value[0], lessons: existingLessons.value });
        }

        const lessons = [];
        for (const studentId of participantIds) {
          const lesson = await tx.lessons.createLesson({
            teacherId: schedule.value.teacherId,
            studentId,
            scheduleId: schedule.value.id,
            date: schedule.value.scheduledStart,
            status: input.lessonStatus ?? 'attended',
          });
          if (!lesson.ok) return lesson;
          lessons.push(lesson.value);
        }

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

        for (const lesson of lessons) {
          const lessonAudit = await tx.changelog.recordChange({
            teacherId: input.teacherId,
            module: 'lessons',
            action: 'create',
            targetType: 'Lesson',
            targetId: lesson.id,
            before: null,
            after: toLessonAuditData(lesson),
            source: 'system',
          });
          if (!lessonAudit.ok) return err(internalError(AUDIT_FAILURE_MESSAGE));
        }

        return ok({ schedule: completed.value, lesson: lessons[0], lessons });
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
    participantIds: schedule.participantIds,
    location: schedule.location,
    classFormat: schedule.classFormat,
    operationalNote: schedule.operationalNote,
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
