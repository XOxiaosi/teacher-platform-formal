import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { FieldCipher } from '../../shared/field-encryption/index.js';

export type MemoStatus = 'active' | 'done' | 'archived';

export interface CreateMemoServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  /** P8 phase-3 批6：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

export interface CreateMemoInput {
  teacherId: string;
  title: string;
  content: string;
  dueAt?: Date;
  tags?: unknown;
  source?: string;
}

export interface GetMemoInput {
  teacherId: string;
  memoId: string;
}

export interface ListMemosInput {
  teacherId: string;
  status?: MemoStatus;
  dueBefore?: Date;
  tag?: string;
  page?: number;
  pageSize?: number;
}

export interface UpdateMemoInput {
  teacherId: string;
  memoId: string;
  title?: string;
  content?: string;
  dueAt?: Date;
  tags?: unknown;
  source?: string;
}

export type MemoJsonValue =
  | null
  | boolean
  | number
  | string
  | MemoJsonValue[]
  | { [key: string]: MemoJsonValue };

export interface MemoChanges {
  title?: string;
  content?: string;
  dueAt?: Date | null;
  tags?: MemoJsonValue | null;
}

export interface UpdateMemoOwnerInput {
  teacherId: string;
  memoId: string;
  expectedUpdatedAt?: Date;
  changes: MemoChanges;
}

export interface MemoEdit {
  before: MemoData;
  after: MemoData;
}

export interface MemoEditor {
  updateMemo(input: UpdateMemoOwnerInput): Promise<Result<MemoEdit, CommonError>>;
}

export interface UpdateMemoStatusInput {
  teacherId: string;
  memoId: string;
  status: MemoStatus;
}

export interface ListDueMemosInput {
  teacherId: string;
  dueBefore: Date;
}

export interface ListAgendaMemosInput {
  teacherId: string;
  dueAtFrom?: Date;
  dueAtBefore: Date;
}

export interface MemoData {
  id: string;
  teacherId: string;
  title: string;
  content: string;
  status: MemoStatus;
  dueAt: Date | null;
  tags: unknown;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoService {
  createMemo(input: CreateMemoInput): Promise<Result<MemoData, CommonError>>;
  getMemo(input: GetMemoInput): Promise<Result<MemoData, CommonError>>;
  listMemos(input: ListMemosInput): Promise<Result<{ items: MemoData[]; total: number }, CommonError>>;
  listAgendaMemos(input: ListAgendaMemosInput): Promise<Result<{ items: MemoData[]; total: number }, CommonError>>;
  updateMemo(input: UpdateMemoInput): Promise<Result<MemoData, CommonError>>;
  updateMemoStatus(input: UpdateMemoStatusInput): Promise<Result<MemoData, CommonError>>;
  listDueMemos(input: ListDueMemosInput): Promise<Result<MemoData[], CommonError>>;
}
