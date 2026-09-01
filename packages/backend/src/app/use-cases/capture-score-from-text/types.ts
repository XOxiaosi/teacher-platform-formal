import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiClient } from '../../../shared/ai-client/types.js';
import type { AssessmentService } from '../../../features/assessments/types.js';

export interface CaptureScoreFromTextInput {
  teacherId: string;
  studentId: string;
  rawText: string;
  occurredAt?: Date;
}

export interface ScoreExtraction {
  studentName?: string | null;
  examName?: string | null;
  subject?: string | null;
  score?: number | null;
  fullScore?: number | null;
  examDate?: string | null;
  previousScore?: number | null;
  note?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
}

export interface CaptureScoreFromTextResult {
  studentId: string;
  extraction: ScoreExtraction;
  record: import('../../../features/assessments/types.js').StudentRecordData;
  detail: import('../../../features/assessments/types.js').AssessmentDetailData;
  sourceRecord: { id: string } | null;
}

export interface CreateCaptureScoreFromTextUseCaseOptions {
  prisma: PrismaClient;
  aiClient: AiClient;
  assessments: AssessmentService;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
}

export interface CaptureScoreFromTextUseCase {
  execute(input: CaptureScoreFromTextInput): Promise<Result<CaptureScoreFromTextResult, CommonError>>;
}
