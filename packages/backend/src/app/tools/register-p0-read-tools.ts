import type { PrismaClient } from '@prisma/client';
import { notFound, validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import { createStudentService } from '../../features/students/index.js';
import { createScheduleService } from '../../features/scheduling/index.js';
import { createLessonService } from '../../features/lessons/index.js';
import { createPaymentService } from '../../features/payments/index.js';
import { parseDateArg, parsePageArg } from './tool-arg-parsers.js';

type ReadToolsClientProvider = PrismaClient | { getClient: () => Promise<PrismaClient> };

function readToolsGetClient(provider: ReadToolsClientProvider): () => Promise<PrismaClient> {
  return typeof provider === 'object'
    && provider !== null
    && typeof (provider as { getClient?: unknown }).getClient === 'function'
    ? (provider as { getClient: () => Promise<PrismaClient> }).getClient
    : async () => provider as PrismaClient;
}

export function registerP0ReadTools(registry: ToolRegistry, prismaOrGetClient: ReadToolsClientProvider): void {
  const getClient = readToolsGetClient(prismaOrGetClient);
  const students = createStudentService({ getClient });
  const schedules = createScheduleService({ getClient });
  const lessons = createLessonService({ getClient });
  const payments = createPaymentService({ getClient });

  // students.get：只读，按 teacherId 隔离
  registry.register(
    {
      name: 'students.get',
      description: '获取当前老师的单个学生详情',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
        },
        required: ['studentId'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.studentId !== 'string' || a.studentId.trim() === '') {
        return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
      }

      const result = await students.getStudent(a.studentId);
      if (!result.ok) return result;
      if (result.value.teacherId !== context.teacherId) {
        return { ok: false, error: notFound('学生不存在') };
      }
      return result;
    },
  );

  // students.list：只读，按 teacherId 隔离
  registry.register(
    {
      name: 'students.list',
      description: '列出当前老师的所有学生',
      sideEffect: 'read',
      parameters: {},
    },
    async (_args, context) => {
      return students.listStudents({ teacherId: context.teacherId });
    },
  );

  // scheduling.list：只读，按 teacherId 隔离
  registry.register(
    {
      name: 'scheduling.list',
      description: '列出当前老师的所有日程',
      sideEffect: 'read',
      parameters: {},
    },
    async (_args, context) => {
      return schedules.listSchedules({ teacherId: context.teacherId });
    },
  );

  // lessons.list：只读，按 teacherId 隔离
  registry.register(
    {
      name: 'lessons.list',
      description: '列出当前老师的课次记录',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID 过滤' },
          status: { type: 'string', description: '课次状态过滤' },
          dateFrom: { type: 'string', description: '课次日期下限（ISO 8601）' },
          dateTo: { type: 'string', description: '课次日期上限（ISO 8601）' },
          page: { type: 'number', description: '页码' },
          pageSize: { type: 'number', description: '每页数量' },
        },
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;
      const dateFrom = parseDateArg(a.dateFrom);
      if (dateFrom && typeof dateFrom === 'object' && 'error' in dateFrom) {
        return { ok: false, error: validationError('dateFrom 格式无效', 'dateFrom') };
      }
      const dateTo = parseDateArg(a.dateTo);
      if (dateTo && typeof dateTo === 'object' && 'error' in dateTo) {
        return { ok: false, error: validationError('dateTo 格式无效', 'dateTo') };
      }

      return lessons.listLessons({
        teacherId: context.teacherId,
        studentId: typeof a.studentId === 'string' ? a.studentId : undefined,
        status: typeof a.status === 'string' ? a.status : undefined,
        dateFrom: dateFrom instanceof Date ? dateFrom : undefined,
        dateTo: dateTo instanceof Date ? dateTo : undefined,
        page: parsePageArg(a.page),
        pageSize: parsePageArg(a.pageSize),
      });
    },
  );

  // payments.list：只读，按 teacherId 隔离
  registry.register(
    {
      name: 'payments.list',
      description: '列出当前老师的缴费记录',
      sideEffect: 'read',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID 过滤' },
          paidAtFrom: { type: 'string', description: '缴费时间下限（ISO 8601）' },
          paidAtTo: { type: 'string', description: '缴费时间上限（ISO 8601）' },
          page: { type: 'number', description: '页码' },
          pageSize: { type: 'number', description: '每页数量' },
        },
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;
      const paidAtFrom = parseDateArg(a.paidAtFrom);
      if (paidAtFrom && typeof paidAtFrom === 'object' && 'error' in paidAtFrom) {
        return { ok: false, error: validationError('paidAtFrom 格式无效', 'paidAtFrom') };
      }
      const paidAtTo = parseDateArg(a.paidAtTo);
      if (paidAtTo && typeof paidAtTo === 'object' && 'error' in paidAtTo) {
        return { ok: false, error: validationError('paidAtTo 格式无效', 'paidAtTo') };
      }

      return payments.listPayments({
        teacherId: context.teacherId,
        studentId: typeof a.studentId === 'string' ? a.studentId : undefined,
        paidAtFrom: paidAtFrom instanceof Date ? paidAtFrom : undefined,
        paidAtTo: paidAtTo instanceof Date ? paidAtTo : undefined,
        page: parsePageArg(a.page),
        pageSize: parsePageArg(a.pageSize),
      });
    },
  );
}
