import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { DailyReviewData } from '../../../features/daily-review/index.js';
import type { LessonData } from '../../../features/lessons/index.js';
import type { ScheduleData } from '../../../features/scheduling/index.js';
import type { ChangelogFactory } from '../../../shared/changelog/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import type { TrustedClock } from '../../../shared/trusted-clock/index.js';

export type DailyReviewAssemblePrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateDailyReviewAssembleUseCaseOptions {
  prisma: DailyReviewAssemblePrismaClient;
  trustedClock: TrustedClock;
  /** 请求期解析教师数据库 client；未提供时回退装配期 prisma。 */
  getClient?: () => Promise<DailyReviewAssemblePrismaClient>;
  /** ChangeLog 显式审计复用的字段加密器。 */
  cipher?: FieldCipher;
  /** tx-bound ChangeLog factory；仅供测试注入失败点。 */
  changelogFactory?: ChangelogFactory;
}

export interface AssembleDailyReviewInput {
  teacherId: string;
  date?: string;
}

export interface DailyReviewAssembleResult {
  review: DailyReviewData;
  schedules: ScheduleData[];
  lessons: LessonData[];
}

export interface DailyReviewAssembleUseCase {
  assembleDailyReview(input: AssembleDailyReviewInput): Promise<Result<DailyReviewAssembleResult, CommonError>>;
}

export type DailyReviewAssembleFactory = (options: CreateDailyReviewAssembleUseCaseOptions) => DailyReviewAssembleUseCase;
