import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';

export interface BalanceCalcInput {
  teacherId: string;
  studentId: string;
}

export interface LessonBalance {
  purchased: number;
  attended: number;
  remaining: number;
}

export interface BalanceCalcUseCase {
  calculateBalance(input: BalanceCalcInput): Promise<Result<LessonBalance, CommonError>>;
}

export type BalanceCalcFactory = (
  prismaOrOptions: PrismaClient | { getClient: () => Promise<PrismaClient> },
) => BalanceCalcUseCase;
