import type { Prisma } from '@prisma/client';
import {
  err,
  ok,
  validationError,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import { createParentFeedbackContentEditor } from '../../features/feedback/index.js';
import { createLessonRecordEditor } from '../../features/lessons/index.js';
import { createMemoEditor } from '../../features/memos/index.js';
import { createPaymentEditor } from '../../features/payments/index.js';
import { createScheduleRescheduler } from '../../features/scheduling/index.js';
import { createStudentProfileEditor } from '../../features/students/index.js';
import { createChangelogService } from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createRescheduleLessonUseCaseWithServices,
  type RescheduleLessonCommand,
} from '../use-cases/reschedule-lesson/index.js';
import {
  createUpdateLessonRecordUseCaseWithServices,
  type UpdateLessonRecordCommand,
} from '../use-cases/update-lesson-record/index.js';
import {
  createUpdateMemoUseCaseWithServices,
  type UpdateMemoCommand,
} from '../use-cases/update-memo/index.js';
import {
  createUpdateParentFeedbackContentUseCaseWithServices,
  type UpdateParentFeedbackContentCommand,
} from '../use-cases/update-parent-feedback-content/index.js';
import {
  createUpdatePaymentUseCaseWithServices,
  type UpdatePaymentCommand,
} from '../use-cases/update-payment/index.js';
import {
  createUpdateStudentProfileUseCaseWithServices,
  type UpdateStudentProfileCommand,
} from '../use-cases/update-student-profile/index.js';
import type {
  ConfirmableActionExecutionResult,
  ConfirmableActionExecutor,
  ConfirmableActionExecutorInput,
} from './types.js';

export interface EditTypedCommandPorts {
  students: {
    updateStudentProfile(command: UpdateStudentProfileCommand): Promise<Result<unknown, CommonError>>;
  };
  scheduling: {
    rescheduleLesson(command: RescheduleLessonCommand): Promise<Result<unknown, CommonError>>;
  };
  lessons: {
    updateLessonRecord(command: UpdateLessonRecordCommand): Promise<Result<unknown, CommonError>>;
  };
  payments: {
    updatePayment(command: UpdatePaymentCommand): Promise<Result<unknown, CommonError>>;
  };
  memos: {
    updateMemo(command: UpdateMemoCommand): Promise<Result<unknown, CommonError>>;
  };
  feedback: {
    updateParentFeedbackContent(command: UpdateParentFeedbackContentCommand): Promise<Result<unknown, CommonError>>;
  };
}

export interface EditActionExecutors {
  studentUpdateProfile: ConfirmableActionExecutor;
  scheduleReschedule: ConfirmableActionExecutor;
  lessonUpdateRecord: ConfirmableActionExecutor;
  paymentUpdate: ConfirmableActionExecutor;
  memoUpdate: ConfirmableActionExecutor;
  feedbackUpdateContent: ConfirmableActionExecutor;
}

interface ParsedParameters {
  id: string;
  expectedUpdatedAt: string;
  nested: Record<string, unknown>;
}

function invalidParameters(message: string) {
  return err(validationError(message, 'parameters'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseParameters(
  input: ConfirmableActionExecutorInput,
  expectedType: ConfirmableActionExecutorInput['target']['type'],
  idField: string,
  nestedField: 'changes' | 'replacement',
  nestedFields: readonly string[],
  requiredNested: readonly string[] = [],
): Result<ParsedParameters, CommonError> {
  if (input.target.type !== expectedType || !isPlainObject(input.parameters)) {
    return invalidParameters('待确认操作 target 或 parameters 不合法');
  }
  const parameterKeys = Object.keys(input.parameters);
  if (
    parameterKeys.length !== 3
    || !parameterKeys.includes(idField)
    || !parameterKeys.includes(nestedField)
    || !parameterKeys.includes('expectedUpdatedAt')
  ) {
    return invalidParameters('待确认操作 parameters 结构不合法');
  }
  const id = input.parameters[idField];
  const expectedUpdatedAt = input.parameters.expectedUpdatedAt;
  const nested = input.parameters[nestedField];
  if (
    typeof id !== 'string'
    || id === ''
    || id !== input.target.id
    || typeof expectedUpdatedAt !== 'string'
    || expectedUpdatedAt === ''
    || !isPlainObject(nested)
  ) {
    return invalidParameters('待确认操作 target、ID 或版本快照不一致');
  }
  const nestedKeys = Object.keys(nested);
  if (
    nestedKeys.length === 0
    || nestedKeys.some((key) => !nestedFields.includes(key))
    || requiredNested.some((key) => !Object.hasOwn(nested, key))
  ) {
    return invalidParameters(`待确认操作 ${nestedField} 结构不合法`);
  }
  return ok({ id, expectedUpdatedAt, nested: structuredClone(nested) });
}

function success(summary: string, type: ConfirmableActionExecutorInput['target']['type'], id: string) {
  return ok<ConfirmableActionExecutionResult>({ summary, references: [{ type, id }] });
}

export function createEditActionExecutorsWithCommands(
  commands: EditTypedCommandPorts,
): EditActionExecutors {
  return {
    studentUpdateProfile: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'Student',
          'studentId',
          'changes',
          ['name', 'grade', 'stageGoal'],
        );
        if (!parsed.ok) return parsed;
        const result = await commands.students.updateStudentProfile({
          teacherId: input.teacherId,
          studentId: parsed.value.id,
          changes: parsed.value.nested as UpdateStudentProfileCommand['changes'],
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('学生资料已更新', 'Student', parsed.value.id) : result;
      },
    },
    scheduleReschedule: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'Schedule',
          'scheduleId',
          'replacement',
          ['scheduledStart', 'scheduledEnd'],
          ['scheduledStart', 'scheduledEnd'],
        );
        if (!parsed.ok) return parsed;
        const scheduledStart = parsed.value.nested.scheduledStart;
        const scheduledEnd = parsed.value.nested.scheduledEnd;
        if (typeof scheduledStart !== 'string' || typeof scheduledEnd !== 'string') {
          return invalidParameters('待确认操作 replacement 时间不合法');
        }
        const result = await commands.scheduling.rescheduleLesson({
          teacherId: input.teacherId,
          scheduleId: parsed.value.id,
          replacement: { scheduledStart, scheduledEnd },
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('日程已改期', 'Schedule', parsed.value.id) : result;
      },
    },
    lessonUpdateRecord: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'Lesson',
          'lessonId',
          'changes',
          ['progress', 'studentState', 'homework', 'teacherNote'],
        );
        if (!parsed.ok) return parsed;
        const result = await commands.lessons.updateLessonRecord({
          teacherId: input.teacherId,
          lessonId: parsed.value.id,
          changes: parsed.value.nested as UpdateLessonRecordCommand['changes'],
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('课次记录已更新', 'Lesson', parsed.value.id) : result;
      },
    },
    paymentUpdate: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'Payment',
          'paymentId',
          'changes',
          ['amount', 'lessonCount', 'paidAt', 'note'],
        );
        if (!parsed.ok) return parsed;
        const result = await commands.payments.updatePayment({
          teacherId: input.teacherId,
          paymentId: parsed.value.id,
          changes: parsed.value.nested as UpdatePaymentCommand['changes'],
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('缴费记录已更新', 'Payment', parsed.value.id) : result;
      },
    },
    memoUpdate: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'Memo',
          'memoId',
          'changes',
          ['title', 'content', 'dueAt', 'tags'],
        );
        if (!parsed.ok) return parsed;
        const result = await commands.memos.updateMemo({
          teacherId: input.teacherId,
          memoId: parsed.value.id,
          changes: parsed.value.nested as UpdateMemoCommand['changes'],
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('备忘已更新', 'Memo', parsed.value.id) : result;
      },
    },
    feedbackUpdateContent: {
      async execute(input) {
        const parsed = parseParameters(
          input,
          'ParentFeedback',
          'feedbackId',
          'changes',
          ['title', 'content'],
        );
        if (!parsed.ok) return parsed;
        const result = await commands.feedback.updateParentFeedbackContent({
          teacherId: input.teacherId,
          feedbackId: parsed.value.id,
          changes: parsed.value.nested as UpdateParentFeedbackContentCommand['changes'],
          expectedUpdatedAt: parsed.value.expectedUpdatedAt,
          source: 'agent-confirmed',
        });
        return result.ok ? success('家长反馈内容已更新', 'ParentFeedback', parsed.value.id) : result;
      },
    },
  };
}

export function createDatabaseEditActionExecutors(
  tx: Prisma.TransactionClient,
): EditActionExecutors {
  const trustedClock = createDatabaseTrustedClock(tx);
  const changelog = createChangelogService(tx);
  const students = createUpdateStudentProfileUseCaseWithServices({
    transaction: (work) => work({
      students: createStudentProfileEditor({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  const scheduling = createRescheduleLessonUseCaseWithServices({
    transaction: (work) => work({
      scheduling: createScheduleRescheduler({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  const lessons = createUpdateLessonRecordUseCaseWithServices({
    transaction: (work) => work({
      lessons: createLessonRecordEditor({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  const payments = createUpdatePaymentUseCaseWithServices({
    transaction: (work) => work({
      payments: createPaymentEditor({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  const memos = createUpdateMemoUseCaseWithServices({
    transaction: (work) => work({
      memos: createMemoEditor({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  const feedback = createUpdateParentFeedbackContentUseCaseWithServices({
    transaction: (work) => work({
      feedback: createParentFeedbackContentEditor({ prisma: tx, trustedClock }),
      changelog,
    }),
  });
  return createEditActionExecutorsWithCommands({
    students,
    scheduling,
    lessons,
    payments,
    memos,
    feedback,
  });
}
