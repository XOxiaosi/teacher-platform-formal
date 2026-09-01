import type { Prisma } from '@prisma/client';
import { err, internalError, notFound, ok, validationError } from '@teacher-platform/contracts';
import { createLessonService, type LessonStatus } from '../../features/lessons/index.js';
import { createScheduleService } from '../../features/scheduling/index.js';
import { createStudentService, type StudentStatus } from '../../features/students/index.js';
import { createChangelogService } from '../../shared/changelog/index.js';
import type {
  ConfirmableActionExecutionResult,
  ConfirmableActionExecutor,
  ConfirmableActionExecutorInput,
} from './types.js';

function invalidParameters(message: string) {
  return err(validationError(message, 'parameters'));
}

function readParameters(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function targetId(
  input: ConfirmableActionExecutorInput,
  expectedType: 'Student' | 'Schedule' | 'Lesson',
  idField: 'studentId' | 'scheduleId' | 'lessonId',
) {
  const parameters = readParameters(input.parameters);
  if (
    input.target.type !== expectedType
    || !parameters
    || typeof parameters[idField] !== 'string'
    || parameters[idField] !== input.target.id
  ) {
    return invalidParameters('待确认操作 target 与 parameters 不一致');
  }
  return ok({ id: input.target.id, parameters });
}

function lessonStatus(value: unknown): value is LessonStatus {
  return value === 'pending' || value === 'attended' || value === 'absent';
}

function studentStatus(value: unknown): value is StudentStatus {
  return value === 'active' || value === 'paused' || value === 'finished';
}

export function createDatabaseActionExecutors(tx: Prisma.TransactionClient): {
  scheduleComplete: ConfirmableActionExecutor;
  scheduleCancel: ConfirmableActionExecutor;
  lessonUpdateStatus: ConfirmableActionExecutor;
  studentUpdateStatus: ConfirmableActionExecutor;
} {
  const schedules = createScheduleService(tx);
  const lessons = createLessonService(tx);
  const students = createStudentService(tx);
  const changelog = createChangelogService(tx);

  const scheduleExecutor = (targetStatus: 'completed' | 'cancelled'): ConfirmableActionExecutor => ({
    async execute(input) {
      const parsed = targetId(input, 'Schedule', 'scheduleId');
      if (!parsed.ok) return parsed;
      const existing = await schedules.getSchedule(parsed.value.id);
      if (!existing.ok) return existing;
      if (existing.value.teacherId !== input.teacherId) return err(notFound('日程不存在'));
      const updated = await schedules.updateScheduleStatus({
        scheduleId: parsed.value.id,
        targetStatus,
      });
      if (!updated.ok) return updated;
      const audit = await changelog.recordChange({
        teacherId: input.teacherId,
        module: 'scheduling',
        action: targetStatus === 'cancelled' ? 'cancel' : 'update',
        targetType: 'Schedule',
        targetId: updated.value.id,
        before: { status: existing.value.status },
        after: { status: updated.value.status },
        source: 'system',
      });
      if (!audit.ok) return err(internalError('变更记录写入失败'));
      return ok<ConfirmableActionExecutionResult>({
        summary: targetStatus === 'completed' ? '日程已完成' : '日程已取消',
        references: [{ type: 'Schedule', id: updated.value.id }],
      });
    },
  });

  return {
    scheduleComplete: scheduleExecutor('completed'),
    scheduleCancel: scheduleExecutor('cancelled'),

    lessonUpdateStatus: {
      async execute(input) {
        const parsed = targetId(input, 'Lesson', 'lessonId');
        if (!parsed.ok) return parsed;
        if (!lessonStatus(parsed.value.parameters.status)) {
          return invalidParameters('课次目标状态不合法');
        }
        const existing = await lessons.getLesson(parsed.value.id);
        if (!existing.ok) return existing;
        if (existing.value.teacherId !== input.teacherId) return err(notFound('课次不存在'));
        const updated = await lessons.updateLessonStatus({
          lessonId: parsed.value.id,
          targetStatus: parsed.value.parameters.status,
        });
        if (!updated.ok) return updated;
        const audit = await changelog.recordChange({
          teacherId: input.teacherId,
          module: 'lessons',
          action: 'update',
          targetType: 'Lesson',
          targetId: updated.value.id,
          before: { status: existing.value.status },
          after: { status: updated.value.status },
          source: 'system',
        });
        if (!audit.ok) return err(internalError('变更记录写入失败'));
        return ok({
          summary: '课次状态已更新',
          references: [{ type: 'Lesson' as const, id: updated.value.id }],
        });
      },
    },

    studentUpdateStatus: {
      async execute(input) {
        const parsed = targetId(input, 'Student', 'studentId');
        if (!parsed.ok) return parsed;
        if (!studentStatus(parsed.value.parameters.status)) {
          return invalidParameters('学生目标状态不合法');
        }
        const existing = await students.getStudent(parsed.value.id);
        if (!existing.ok) return existing;
        if (existing.value.teacherId !== input.teacherId) return err(notFound('学生不存在'));
        const updated = await students.updateStudentStatus({
          studentId: parsed.value.id,
          targetStatus: parsed.value.parameters.status,
        });
        if (!updated.ok) return updated;
        const audit = await changelog.recordChange({
          teacherId: input.teacherId,
          module: 'students',
          action: 'update',
          targetType: 'Student',
          targetId: updated.value.id,
          before: { currentStatus: existing.value.currentStatus },
          after: { currentStatus: updated.value.currentStatus },
          source: 'system',
        });
        if (!audit.ok) return err(internalError('变更记录写入失败'));
        return ok({
          summary: '学生状态已更新',
          references: [{ type: 'Student' as const, id: updated.value.id }],
        });
      },
    },
  };
}
