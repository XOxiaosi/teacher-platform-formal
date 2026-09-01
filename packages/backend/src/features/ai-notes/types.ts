import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { AiClient } from '../../shared/ai-client/index.js';
import type { StorageService } from '../../shared/storage/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export type AiInputType = 'voice' | 'text';
export type AiConfidence = 'high' | 'medium' | 'low';
export type AiNoteStatus = 'processed' | 'pending' | 'failed';
export type AiIntent =
  | 'schedule_create'
  | 'schedule_modify'
  | 'schedule_query'
  | 'lesson_record'
  | 'student_update'
  | 'review_input'
  | 'general_note';

export interface CreateAiNoteServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  aiClient: AiClient;
  storage: StorageService;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  /** P8 phase-3 批3：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

export interface ParseInputInput {
  teacherId: string;
  inputType: AiInputType;
  text?: string;
  audio?: Buffer;
  filename?: string;
}

export interface SaveAiNoteInput {
  teacherId: string;
  inputType: AiInputType;
  rawInput: string;
  audioFileRef?: string | null;
  intent?: AiIntent | null;
  extractedData?: Record<string, unknown>;
  confidence?: AiConfidence | null;
  pendingFields: string[];
  status: AiNoteStatus;
  routedTo?: string | null;
  routedModuleId?: string | null;
}

export interface AiNoteData extends SaveAiNoteInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParseInputOutput extends Omit<AiNoteData, 'id' | 'createdAt' | 'updatedAt'> {
  defaultsApplied: Record<string, unknown>;
  locatingConditions?: Record<string, unknown>;
}

export interface AiNoteService {
  parseInput(input: ParseInputInput): Promise<Result<ParseInputOutput, CommonError>>;
  saveNote(input: SaveAiNoteInput): Promise<Result<AiNoteData, CommonError>>;
}
