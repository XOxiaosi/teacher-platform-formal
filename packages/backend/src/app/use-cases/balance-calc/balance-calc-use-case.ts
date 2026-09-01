import type { PrismaClient } from '@prisma/client';
import { err, notFound, ok } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createPaymentService } from '../../../features/payments/index.js';
import type { BalanceCalcInput, BalanceCalcUseCase } from './types.js';

/**
 * S2 平移：工厂签名从 createBalanceCalcUseCase(prisma) 扩展为
 * createBalanceCalcUseCase(prisma | { getClient })——向后兼容。
 * getClient 请求期解析（数据库路由），未配置时回退装配期 client。
 * 内部组合的 lesson/payment 服务按「解析出的 client」装配（S3 逐组平移）。
 */
export interface BalanceCalcUseCaseOptions {
  getClient: () => Promise<PrismaClient>;
}

function isBalanceCalcUseCaseOptions(
  value: PrismaClient | BalanceCalcUseCaseOptions,
): value is BalanceCalcUseCaseOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as BalanceCalcUseCaseOptions).getClient === 'function';
}

export function createBalanceCalcUseCase(
  prismaOrOptions: PrismaClient | BalanceCalcUseCaseOptions,
): BalanceCalcUseCase {
  const getClient = isBalanceCalcUseCaseOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;

  return {
    async calculateBalance(input: BalanceCalcInput) {
      const prisma = await getClient();
      const lessons = createLessonService(prisma);
      const payments = createPaymentService(prisma);

      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) return err(notFound('学生不存在'));

      const purchased = await payments.sumLessonCount({ studentId: input.studentId });
      if (!purchased.ok) return purchased;

      const attended = await lessons.countByStudent({
        studentId: input.studentId,
        status: 'attended',
      });
      if (!attended.ok) return attended;

      return ok({
        purchased: purchased.value,
        attended: attended.value,
        remaining: purchased.value - attended.value,
      });
    },
  };
}
