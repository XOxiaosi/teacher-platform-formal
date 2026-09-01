import type { Prisma, PrismaClient } from '@prisma/client';
import { ok, err, notFound, validationError, internalError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { StudentService } from './types.js';
import type { CreateStudentInput, ListStudentsInput, UpdateStudentInput, UpdateStudentStatusInput, StudentData } from './types.js';
import { validateStudentTransition, type StudentStatus } from './state-machine.js';

const STUDENT_STATUSES = ['active', 'paused', 'finished'];
const AGENDA_SOURCE_LIMIT = 500;
const MAX_ID_LENGTH = 128;

type StudentPrismaClient = PrismaClient | Prisma.TransactionClient;

/**
 * S2 平移：工厂签名从 createStudentService(prisma) 扩展为
 * createStudentService(prisma | { getClient })——向后兼容（旧调用传 prisma 直接可用）。
 * getClient 请求期解析（数据库路由），未配置时回退装配期 client，保持单库行为。
 */
export interface StudentServiceOptions {
  getClient: () => Promise<StudentPrismaClient>;
}

function isStudentServiceOptions(
  value: StudentPrismaClient | StudentServiceOptions,
): value is StudentServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StudentServiceOptions).getClient === 'function';
}

export function createStudentService(
  prismaOrOptions: StudentPrismaClient | StudentServiceOptions,
): StudentService {
  const getClient = isStudentServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;

  async function resolve(): Promise<{ prisma: StudentPrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createStudent(input: CreateStudentInput) {
      if (!input.name || input.name.trim() === '') {
        return err(validationError('学生姓名不能为空', 'name'));
      }
      if (!input.grade || input.grade.trim() === '') {
        return err(validationError('年级不能为空', 'grade'));
      }

      const { prisma, trustedClock } = await resolve();
      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const student = await prisma.student.create({
        data: {
          teacherId: input.teacherId,
          name: input.name,
          grade: input.grade,
          source: input.source ?? null,
          stageGoal: input.stageGoal ?? null,
          createdAtTs: now.value,
          updatedAtTs: now.value,
        },
      });

      return ok(toStudentData(student));
    },

    async getStudent(studentId: string) {
      const prisma = await getClient();
      const student = await prisma.student.findUnique({
        where: { id: studentId },
      });

      if (!student) {
        return err(notFound('学生不存在'));
      }

      return ok(toStudentData(student));
    },

    async getOwnedStudent(input) {
      const prisma = await getClient();
      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
      });
      return student ? ok(toStudentData(student)) : err(notFound('学生不存在'));
    },

    async listStudents(input: ListStudentsInput) {
      const prisma = await getClient();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      if (input.status && !STUDENT_STATUSES.includes(input.status)) {
        return err(validationError('学生状态不合法', 'status'));
      }
      const skip = (page - 1) * pageSize;

      const where = {
        teacherId: input.teacherId,
        ...(input.status && { currentStatus: input.status }),
      };

      const [items, total] = await Promise.all([
        prisma.student.findMany({ where, skip, take: pageSize }),
        prisma.student.count({ where }),
      ]);

      return ok({ items: items.map(toStudentData), total });
    },

    async listOwnedStudentsByIds(input) {
      if (!input.teacherId.trim()) {
        return err(validationError('teacherId 无效', 'teacherId'));
      }
      if (!Array.isArray(input.studentIds)) {
        return err(validationError('studentIds 必须是数组', 'studentIds'));
      }
      if (input.studentIds.some((id) => (
        typeof id !== 'string' || id.trim().length === 0 || id.length > MAX_ID_LENGTH
      ))) {
        return err(validationError('studentIds 包含无效ID', 'studentIds'));
      }
      const studentIds = [...new Set(input.studentIds)];
      if (studentIds.length > AGENDA_SOURCE_LIMIT) {
        return err(validationError('studentIds 数量超过限制', 'studentIds'));
      }
      if (studentIds.length === 0) return ok([]);

      const prisma = await getClient();
      const students = await prisma.student.findMany({
        where: { teacherId: input.teacherId, id: { in: studentIds } },
        orderBy: { id: 'asc' },
      });
      return ok(students.map(toStudentData));
    },

    async updateStudent(input: UpdateStudentInput) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.student.findUnique({
        where: { id: input.studentId },
      });

      if (!existing) {
        return err(notFound('学生不存在'));
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updated = await prisma.student.update({
        where: { id: input.studentId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.grade !== undefined && { grade: input.grade }),
          ...(input.source !== undefined && { source: input.source }),
          ...(input.stageGoal !== undefined && { stageGoal: input.stageGoal }),
          updatedAtTs: now.value,
        },
      });

      return ok(toStudentData(updated));
    },

    async updateStudentStatus(input: UpdateStudentStatusInput) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.student.findUnique({
        where: { id: input.studentId },
      });

      if (!existing) {
        return err(notFound('学生不存在'));
      }

      const transition = validateStudentTransition(
        existing.currentStatus as StudentStatus,
        input.targetStatus,
      );

      if (!transition.ok) {
        return transition;
      }

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const updated = await prisma.student.update({
        where: { id: input.studentId },
        data: {
          currentStatus: input.targetStatus,
          updatedAtTs: now.value,
        },
      });

      return ok(toStudentData(updated));
    },
  };
}

function toStudentData(record: any): StudentData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    name: record.name,
    grade: record.grade,
    source: record.source,
    currentStatus: record.currentStatus,
    stageGoal: record.stageGoal,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}