import type { PrismaClient } from '@prisma/client';
import { err, validationError } from '@teacher-platform/contracts';
import { createToolRegistry } from '../../shared/tool-registry/tool-registry.js';
import { registerP0ReadTools } from '../tools/register-p0-read-tools.js';
import { createBalanceCalcUseCase } from '../use-cases/balance-calc/balance-calc-use-case.js';

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
  return registry;
}
