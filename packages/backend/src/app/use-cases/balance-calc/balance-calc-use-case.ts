import type { PrismaClient } from '@prisma/client';
import { ok } from '@teacher-platform/contracts';
import { createLessonLedgerService } from '../../../features/payments/index.js';
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
      // T-017：权威余额来自不可变课时账本；内部兼容尚未关联账本的历史 Payment。
      const balance = await createLessonLedgerService(prisma).calculateBalance(input);
      if (!balance.ok) return balance;
      return ok({
        purchased: balance.value.purchased,
        attended: balance.value.attended,
        adjustments: balance.value.adjustments,
        remaining: balance.value.remaining,
      });
    },
  };
}
