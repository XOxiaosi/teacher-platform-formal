import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { DailyReviewData } from '../../../features/daily-review/index.js';
import type { LessonData } from '../../../features/lessons/index.js';
import type { AiClient } from '../../../shared/ai-client/index.js';
import type { ChangelogFactory } from '../../../shared/changelog/index.js';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';
import type { StorageService } from '../../../shared/storage/index.js';

export interface CreateDailyReviewInteractUseCaseOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  /** 请求期解析教师数据库 client；未提供时回退装配期 prisma。 */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  aiClient: AiClient;
  storage: StorageService;
  /** Lesson、AINote 与 ChangeLog 复用的同一字段加密器。 */
  cipher?: FieldCipher;
  /** 三条显式审计的 tx-bound factory；测试可注入 failure-at-N。 */
  changelogFactory?: ChangelogFactory;
}

export interface InteractDailyReviewInput {
  teacherId: string;
  date: Date;
  text: string;
}

export interface DailyReviewInteractResult {
  lesson: LessonData;
  review: DailyReviewData;
  noteId: string;
}

export interface DailyReviewInteractUseCase {
  interactDailyReview(input: InteractDailyReviewInput): Promise<Result<DailyReviewInteractResult, CommonError>>;
}

export type DailyReviewInteractFactory = (options: CreateDailyReviewInteractUseCaseOptions) => DailyReviewInteractUseCase;
