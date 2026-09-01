import type { PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiClient } from '../../../shared/ai-client/types.js';
import type {
  CommunicationService,
  CommunicationDirection,
  CommunicationChannel,
  CommunicationParentType,
} from '../../../features/student-communications/types.js';

export interface CommunicationExtraction {
  direction?: CommunicationDirection | null;
  channel?: CommunicationChannel | null;
  parentType?: CommunicationParentType | null;
  parentConcerns?: string[] | null;
  teacherResponses?: string[] | null;
  agreements?: string[] | null;
  followUps?: string[] | null;
  nextContactAt?: string | null;
  summary?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
}

export interface CaptureCommunicationFromTextInput {
  teacherId: string;
  studentId: string;
  rawText: string;
  occurredAt?: Date;
}

export interface CaptureCommunicationFromTextResult {
  studentId: string;
  extraction: CommunicationExtraction;
  record: import('../../../features/student-communications/types.js').StudentRecordData;
  detail: import('../../../features/student-communications/types.js').CommunicationDetailData;
  sourceRecord: { id: string } | null;
}

export interface CreateCaptureCommunicationFromTextUseCaseOptions {
  prisma: PrismaClient;
  aiClient: AiClient;
  communications: CommunicationService;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient>;
}

export interface CaptureCommunicationFromTextUseCase {
  execute(
    input: CaptureCommunicationFromTextInput,
  ): Promise<Result<CaptureCommunicationFromTextResult, CommonError>>;
}
