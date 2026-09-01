import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiClient } from '../../../shared/ai-client/types.js';
import type {
  AssembleParentFeedbackContextUseCase,
  FeedbackEvidenceItem,
} from '../assemble-parent-feedback-context/types.js';

export type FeedbackDraftTone = 'formal' | 'warm' | 'concise';

export type FeedbackClassSize = '1v1' | 'small' | 'large';
export type FeedbackParentType = 'normal' | 'scores' | 'sensitive';
export type FeedbackFocus = 'highlight' | 'problem' | 'cooperation' | 'summary';

export interface GenerateFeedbackDraftInput {
  teacherId: string;
  studentId: string;
  lessonIds?: string[];
  tone?: FeedbackDraftTone;
  classSize?: FeedbackClassSize;
  parentType?: FeedbackParentType;
  focus?: FeedbackFocus;
}

export interface GenerateFeedbackDraftResult {
  studentId: string;
  lessonIds: string[];
  title: string;
  content: string;
  rationale: string;
  source: 'ai';
  evidence: FeedbackEvidenceItem[];
  windowStart: string;
  windowEnd: string;
  classSize?: FeedbackClassSize;
  parentType?: FeedbackParentType;
  focus?: FeedbackFocus;
}

export interface CreateGenerateFeedbackDraftUseCaseOptions {
  prisma: PrismaClient;
  aiClient: AiClient;
  context: AssembleParentFeedbackContextUseCase;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
}

export interface GenerateFeedbackDraftUseCase {
  execute(input: GenerateFeedbackDraftInput): Promise<Result<GenerateFeedbackDraftResult, CommonError>>;
}
