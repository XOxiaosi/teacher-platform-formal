import type { PrismaClient } from '@prisma/client';
import { validationError } from '@teacher-platform/contracts';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import { createStudentService } from '../../features/students/index.js';
import { createScheduleService } from '../../features/scheduling/index.js';
import { createPlannedScheduleUseCase } from '../use-cases/create-planned-schedule/index.js';

type WriteToolsClientProvider = PrismaClient | { getClient: () => Promise<PrismaClient> };

function writeToolsGetClient(provider: WriteToolsClientProvider): () => Promise<PrismaClient> {
  return typeof provider === 'object'
    && provider !== null
    && typeof (provider as { getClient?: unknown }).getClient === 'function'
    ? (provider as { getClient: () => Promise<PrismaClient> }).getClient
    : async () => provider as PrismaClient;
}

export function registerP0WriteTools(
  registry: ToolRegistry,
  prismaOrGetClient: WriteToolsClientProvider,
  trustedClock: TrustedClock,
): void {
  const getClient = writeToolsGetClient(prismaOrGetClient);
  const students = createStudentService({ getClient });
  const schedules = createScheduleService({ getClient });
  const plannedSchedules = createPlannedScheduleUseCase({ scheduling: schedules, trustedClock });

  // students.create：低风险写操作，创建当前老师的学生
  registry.register(
    {
      name: 'students.create',
      description: '创建当前老师的学生',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '学生姓名' },
          grade: { type: 'string', description: '年级' },
          source: { type: 'string', description: '来源' },
          stageGoal: { type: 'string', description: '阶段目标' },
        },
        required: ['name', 'grade'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;

      if (typeof a.name !== 'string' || a.name.trim() === '') {
        return { ok: false, error: validationError('name 必须是非空字符串', 'name') };
      }
      if (typeof a.grade !== 'string' || a.grade.trim() === '') {
        return { ok: false, error: validationError('grade 必须是非空字符串', 'grade') };
      }

      return students.createStudent({
        teacherId: context.teacherId,
        name: a.name,
        grade: a.grade,
        source: typeof a.source === 'string' ? a.source : undefined,
        stageGoal: typeof a.stageGoal === 'string' ? a.stageGoal : undefined,
      });
    },
  );

  // 旧直写工具仅保留非课程日程。正式课程必须走
  // scheduling.prepare -> 教师确认 -> scheduling-web 的结构化事务。
  registry.register(
    {
      name: 'scheduling.create',
      description: '创建当前老师未来的非课程计划日程；课程必须使用 scheduling.prepare 进入教师确认流程',
      sideEffect: 'create',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID，可选' },
          type: { type: 'string', enum: ['prep', 'meeting', 'call', 'other'], description: '非课程日程类型：prep/meeting/call/other' },
          title: { type: 'string', description: '日程标题' },
          scheduledStart: { type: 'string', description: '开始时间（ISO 8601）' },
          scheduledEnd: { type: 'string', description: '结束时间（ISO 8601）' },
          confidence: { type: 'string', description: '置信度：high/medium/low' },
          sourceInput: { type: 'string', description: '来源输入' },
        },
        required: ['type', 'title', 'scheduledStart', 'scheduledEnd'],
      },
    },
    async (args, context) => {
      const a = args as Record<string, unknown>;
      if (a.type === 'lesson') {
        return {
          ok: false,
          error: validationError('课程必须通过 scheduling.prepare 进入教师确认流程', 'type'),
        };
      }
      return plannedSchedules.create({
        teacherId: context.teacherId,
        studentId: a.studentId,
        type: a.type,
        title: a.title,
        scheduledStart: a.scheduledStart,
        scheduledEnd: a.scheduledEnd,
        confidence: a.confidence,
        sourceInput: a.sourceInput,
      });
    },
  );

  // payments.create：P29-W1 已升级为可信确认（confirmation:'required'）。
  // Agent 工具调用不再直接执行：必须经 ConfirmationGateway 创建 PendingAction，
  // 用户确认后由 payments-create executor 在同一事务内复检归属+版本 CAS 再落库。
  // 此处 handler 固定 fail-closed，防止任何直通执行路径绕过确认。
  registry.register(
    {
      name: 'payments.create',
      description: '创建当前老师的缴费记录',
      sideEffect: 'create',
      confirmation: 'required',
      parameters: {
        type: 'object',
        properties: {
          studentId: { type: 'string', description: '学生 ID' },
          amount: { type: 'number', description: '缴费金额' },
          lessonCount: { type: 'number', description: '购买课时数' },
          paidAt: { type: 'string', description: '缴费时间（ISO 8601）' },
          note: { type: 'string', description: '备注' },
        },
        required: ['studentId', 'amount', 'lessonCount', 'paidAt'],
        additionalProperties: false,
      },
    },
    async (_args, _context) => {
      return {
        ok: false,
        error: validationError('该工具必须通过 ConfirmationGateway 创建待确认操作', 'confirmation'),
      };
    },
  );
}
