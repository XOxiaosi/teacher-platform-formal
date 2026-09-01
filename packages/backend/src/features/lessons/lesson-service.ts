import type { Prisma, PrismaClient } from '@prisma/client';
import { ok, err, internalError, notFound, validationError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type { LessonService } from './types.js';
import type { CreateLessonInput, ListLessonsInput, UpdateLessonInput, UpdateLessonStatusInput, CountByStudentInput, LessonData } from './types.js';
import { validateLessonTransition, type LessonStatus } from './state-machine.js';

type LessonPrismaClient = PrismaClient | Prisma.TransactionClient;

const DAILY_REVIEW_SOURCE_LIMIT = 500;

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export interface LessonServiceOptions {
  getClient: () => Promise<LessonPrismaClient>;
  /** P8 phase-3 批4：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function isLessonServiceOptions(
  value: LessonPrismaClient | LessonServiceOptions,
): value is LessonServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as LessonServiceOptions).getClient === 'function';
}

export function createLessonService(
  prismaOrOptions: LessonPrismaClient | LessonServiceOptions,
): LessonService {
  const getClient = isLessonServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isLessonServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();

  async function resolve(): Promise<{ prisma: LessonPrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createLesson(input: CreateLessonInput) {
      const { prisma, trustedClock } = await resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const lesson = await prisma.lesson.create({
        data: {
          teacherId: input.teacherId,
          studentId: input.studentId,
          scheduleId: input.scheduleId,
          dateTs: input.date,
          status: input.status ?? 'pending',
          createdAtTs: now.value,
          updatedAtTs: now.value,
        },
      });
      return ok(toLessonData(lesson, cipher));
    },

    async getLesson(lessonId: string) {
      const { prisma } = await resolve();
      const lesson = await prisma.lesson.findUnique({ where: { id: lessonId } });
      if (!lesson) return err(notFound('课次不存在'));
      try {
        return ok(toLessonData(lesson, cipher));
      } catch (e) {
        return err(internalError(`查询课次失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async getOwnedLesson(input) {
      const { prisma } = await resolve();
      const lesson = await prisma.lesson.findFirst({
        where: { id: input.lessonId, teacherId: input.teacherId },
      });
      if (!lesson) return err(notFound('课次不存在'));
      try {
        return ok(toLessonData(lesson, cipher));
      } catch (e) {
        return err(internalError(`查询课次失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async listLessons(input: ListLessonsInput) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      const skip = (page - 1) * pageSize;

      const where = {
        teacherId: input.teacherId,
        ...(input.studentId && { studentId: input.studentId }),
        ...(input.status && { status: input.status }),
        ...(input.dateFrom && { dateTs: { gte: input.dateFrom } }),
        ...(input.dateTo && { dateTs: { lte: input.dateTo } }),
      };

      const [items, total] = await Promise.all([
        prisma.lesson.findMany({ where, orderBy: { dateTs: 'desc' }, skip, take: pageSize }),
        prisma.lesson.count({ where }),
      ]);

      try {
        return ok({ items: items.map((item) => toLessonData(item, cipher)), total });
      } catch (e) {
        return err(internalError(`查询课次列表失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async listLessonsInWindow(input) {
      const { prisma } = await resolve();
      const validation = validateDailyReviewWindow(input);
      if (!validation.ok) return validation;

      const items = await prisma.lesson.findMany({
        where: {
          teacherId: input.teacherId,
          dateTs: {
            gte: input.windowStart,
            lt: input.windowEndExclusive,
          },
        },
        orderBy: [{ dateTs: 'asc' }, { id: 'asc' }],
        take: DAILY_REVIEW_SOURCE_LIMIT + 1,
      });
      if (items.length > DAILY_REVIEW_SOURCE_LIMIT) {
        return err(internalError('每日回顾课次来源超过 500 条'));
      }
      return ok({ items: items.map((item) => toLessonData(item, cipher)), total: items.length });
    },

    async updateLesson(input: UpdateLessonInput) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.lesson.findUnique({ where: { id: input.lessonId } });
      if (!existing) return err(notFound('课次不存在'));

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await prisma.lesson.update({
          where: { id: input.lessonId },
          data: {
            ...(input.progress !== undefined && { progress: encryptOptionalField(cipher, input.progress) }),
            ...(input.studentState !== undefined && { studentState: encryptOptionalField(cipher, input.studentState) }),
            ...(input.homework !== undefined && { homework: encryptOptionalField(cipher, input.homework) }),
            ...(input.teacherNote !== undefined && { teacherNote: encryptOptionalField(cipher, input.teacherNote) }),
            updatedAtTs: now.value,
          },
        });
        return ok(toLessonData(updated, cipher));
      } catch (e) {
        return err(internalError(`更新课次失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async updateLessonStatus(input: UpdateLessonStatusInput) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.lesson.findUnique({ where: { id: input.lessonId } });
      if (!existing) return err(notFound('课次不存在'));

      const transition = validateLessonTransition(
        existing.status as LessonStatus,
        input.targetStatus,
      );
      if (!transition.ok) return transition;

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updated = await prisma.lesson.update({
        where: { id: input.lessonId },
        data: { status: input.targetStatus, updatedAtTs: now.value },
      });
      return ok(toLessonData(updated, cipher));
    },

    async countByStudent(input: CountByStudentInput) {
      const { prisma } = await resolve();
      const student = await prisma.student.findUnique({ where: { id: input.studentId } });
      if (!student) return err(notFound('学生不存在'));

      const count = await prisma.lesson.count({
        where: {
          studentId: input.studentId,
          status: input.status ?? 'attended',
        },
      });
      return ok(count);
    },
  };
}

function validateDailyReviewWindow(input: {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
}) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 无效', 'teacherId'));
  }
  if (!isValidDate(input.windowStart) || !isValidDate(input.windowEndExclusive)) {
    return err(validationError('每日回顾时间窗口无效', 'windowStart'));
  }
  if (input.windowEndExclusive <= input.windowStart) {
    return err(validationError('每日回顾结束时间必须晚于开始时间', 'windowEndExclusive'));
  }
  return ok(true);
}

function toLessonData(r: any, cipher: FieldCipher | undefined): LessonData {
  return {
    id: r.id, teacherId: r.teacherId, studentId: r.studentId, scheduleId: r.scheduleId,
    date: r.dateTs, status: r.status,
    progress: r.progress === null ? null : decryptFieldValue(cipher, r.progress),
    studentState: r.studentState === null ? null : decryptFieldValue(cipher, r.studentState),
    homework: r.homework === null ? null : decryptFieldValue(cipher, r.homework),
    teacherNote: r.teacherNote === null ? null : decryptFieldValue(cipher, r.teacherNote),
    sourceNoteId: r.sourceNoteId,
    createdAt: r.createdAtTs, updatedAt: r.updatedAtTs,
  };
}

/** 可空字符串写加密（null 保持 null）。 */
function encryptOptionalField(cipher: FieldCipher | undefined, value: string | null): string | null {
  return value === null ? null : encryptFieldValue(cipher, value);
}