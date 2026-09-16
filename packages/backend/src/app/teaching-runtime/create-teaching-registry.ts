import type { PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import { createToolRegistry } from '../../shared/tool-registry/tool-registry.js';
import { registerP0ReadTools } from '../tools/register-p0-read-tools.js';
import { createBalanceCalcUseCase } from '../use-cases/balance-calc/balance-calc-use-case.js';
import { createFeedbackService } from '../../features/feedback/index.js';
import type { FeedbackStatus } from '../../features/feedback/index.js';
import { parsePageArg } from '../tools/tool-arg-parsers.js';

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

/** Independently assembled query registry. No legacy write executor, provider
 * configuration, shell, or automatic notifier is registered. */
export function createTeachingRegistry(getClient: () => Promise<PrismaClient>) {
  const registry = createToolRegistry();
  registerP0ReadTools(registry, { getClient });
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
