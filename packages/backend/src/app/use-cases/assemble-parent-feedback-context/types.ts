import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../../shared/field-encryption/index.js';

export type FeedbackEvidenceType = 'assessment' | 'record' | 'lesson';

export interface FeedbackEvidenceItem {
  id: string;
  type: FeedbackEvidenceType;
  occurredAt: string;
  category: string | null;
  summary: string | null;
  examName: string | null;
  subject: string | null;
  score: number | null;
  fullScore: number | null;
  previousScore: number | null;
  parentConcerns?: string[] | null;
  followUps?: string[] | null;
}

export interface AssembleParentFeedbackContextInput {
  teacherId: string;
  studentId: string;
}

export interface AssembleParentFeedbackContextResult {
  studentId: string;
  windowStart: string;
  windowEnd: string;
  evidence: FeedbackEvidenceItem[];
}

export interface CreateAssembleParentFeedbackContextUseCaseOptions {
  prisma: PrismaClient;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
  /** P8 phase-3 批1/2：字段加密 cipher（缺省 env 构建；未配置 → 明文旧行直通双读）。 */
  cipher?: FieldCipher;
}

export interface AssembleParentFeedbackContextUseCase {
  execute(
    input: AssembleParentFeedbackContextInput,
  ): Promise<Result<AssembleParentFeedbackContextResult, CommonError>>;
}
