import type { PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import { createToolRegistry } from '../../shared/tool-registry/tool-registry.js';
import { registerP0ReadTools } from '../tools/register-p0-read-tools.js';
import { createBalanceCalcUseCase } from '../use-cases/balance-calc/balance-calc-use-case.js';
import { createFeedbackService } from '../../features/feedback/index.js';
import type { FeedbackStatus } from '../../features/feedback/index.js';
import { createStudentService } from '../../features/students/index.js';
import { parsePageArg } from '../tools/tool-arg-parsers.js';

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

/** Independently assembled teaching registry. It contains audited reads and
 * the teacher-scoped student-list write used by the conversation runtime;
 * scheduling, payment, feedback and other writes stay outside this port. */
export function createTeachingRegistry(getClient: () => Promise<PrismaClient>) {
  const registry = createToolRegistry();
  registerP0ReadTools(registry, { getClient });
  const students = createStudentService({ getClient });
  registry.register({
    name: 'students.create', description: '创建当前老师的学生；姓名和年级需由教师在对话中明确提供', sideEffect: 'create',
    parameters: {
      type: 'object', properties: {
        name: { type: 'string', description: '学生姓名' },
        grade: { type: 'string', description: '年级' },
        source: { type: 'string', description: '来源，可选' },
        stageGoal: { type: 'string', description: '阶段目标，可选' },
      }, required: ['name', 'grade'], additionalProperties: false,
    },
  }, async (args, context) => {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    if (typeof a.name !== 'string' || !a.name.trim()) return err(validationError('需要明确学生姓名', 'name'));
    if (typeof a.grade !== 'string' || !a.grade.trim()) return err(validationError('需要明确学生年级', 'grade'));
    return students.createStudent({
      teacherId: context.teacherId,
      name: a.name,
      grade: a.grade,
      source: typeof a.source === 'string' ? a.source : undefined,
      stageGoal: typeof a.stageGoal === 'string' ? a.stageGoal : undefined,
    });
  });
  const balance = createBalanceCalcUseCase({ getClient });
  registry.register({
    name: 'students.balance', description: '查询学生当前课时余额，以正式账本为准；不扣课',
    sideEffect: 'read', parameters: {
      type: 'object', properties: { studentId: { type: 'string' } }, required: ['studentId'],
      additionalProperties: false,
    },
  }, async (args, context) => {
    const studentId = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).studentId : undefined;
    if (typeof studentId !== 'string' || !studentId.trim()) {
      return err(validationError('需要明确学生后才能核对课时', 'studentId'));
    }
    return balance.calculateBalance({ teacherId: context.teacherId, studentId });
  });
  // Feedback is admitted only as a teacher-scoped read. Creation and status
  // changes remain outside the runtime and require the platform confirmation
  // or explicit save command.
  registry.register({
    name: 'feedback.list', description: '列出当前老师的家长反馈（只读）', sideEffect: 'read',
    parameters: {
      type: 'object', properties: {
        studentId: { type: 'string', description: '学生 ID 过滤' },
        status: { type: 'string', enum: ['draft', 'reviewed', 'sent', 'archived'], description: '反馈状态过滤' },
        page: { type: 'number', description: '页码' }, pageSize: { type: 'number', description: '每页数量' },
      }, additionalProperties: false,
    },
  }, async (args, context) => {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    if (a.status !== undefined && a.status !== null && !isFeedbackStatus(a.status)) {
      return err(validationError('status 必须是 draft/reviewed/sent/archived', 'status'));
    }
    const client = await getClient();
    return createFeedbackService({ prisma: client, getClient }).listFeedbacks({
      teacherId: context.teacherId,
      studentId: typeof a.studentId === 'string' ? a.studentId : undefined,
      status: isFeedbackStatus(a.status) ? a.status : undefined,
      page: parsePageArg(a.page), pageSize: parsePageArg(a.pageSize),
    });
  });
  return registry;
}
