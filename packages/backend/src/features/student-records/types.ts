import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';
export type { StudentRecordReviewStatus } from './state-machine.js';

// ---- 原始证据来源类型 ----
export type SourceType =
  | 'agent_text'
  | 'manual'
  | 'lesson'
  | 'assessment'
  | 'audio'
  | 'image'
  | 'screenshot'
  | 'import';

// ---- 原始证据捕获状态 ----
export type CaptureStatus = 'captured' | 'unresolved' | 'failed' | 'archived';

// ---- 学生记录类别 ----
export type StudentRecordCategory =
  | 'assessment'
  | 'lesson_observation'
  | 'parent_communication'
  | 'learning_state'
  | 'homework'
  | 'goal'
  | 'achievement'
  | 'concern'
  | 'agreement'
  | 'follow_up'
  | 'general_note';

// ---- 置信度 / 可见性 / 重要性 ----
export type Confidence = 'high' | 'medium' | 'low';
export type Visibility = 'internal_only' | 'parent_shareable' | 'needs_review';
export type Importance = 'normal' | 'important' | 'critical';

// ---- 记录操作来源 ----
export type RecordSource = 'manual' | 'ai-note';

// ---- 捕获原始证据：输入 ----
export interface CaptureSourceInput {
  teacherId: string;
  studentId?: string;
  sourceType: SourceType;
  sourceEntityType?: string;
  sourceEntityId?: string;
  rawText: string;
  occurredAt?: Date;
}

// ---- 查询原始证据：输入 ----
export interface GetOwnedSourceInput {
  teacherId: string;
  sourceRecordId: string;
}

// ---- 未解析原始证据列表：输入 ----
export interface ListUnresolvedSourcesInput extends PaginationParams {
  teacherId: string;
}

// ---- 归档原始证据：输入 ----
export interface ArchiveSourceInput {
  teacherId: string;
  sourceRecordId: string;
}

// ---- 原始证据数据（与 Prisma 模型对应） ----
export interface StudentSourceRecordData {
  id: string;
  teacherId: string;
  studentId: string | null;
  sourceType: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  occurredAt: Date;
  rawText: string | null;
  contentHash: string | null;
  captureStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- 原始证据服务契约 ----
export interface StudentSourceRecordService {
  captureSource(input: CaptureSourceInput): Promise<Result<StudentSourceRecordData, CommonError>>;
  getOwnedSource(input: GetOwnedSourceInput): Promise<Result<StudentSourceRecordData, CommonError>>;
  listUnresolvedSources(
    input: ListUnresolvedSourcesInput,
  ): Promise<Result<{ items: StudentSourceRecordData[]; total: number }, CommonError>>;
  archiveSource(input: ArchiveSourceInput): Promise<Result<StudentSourceRecordData, CommonError>>;
}

// ---- 创建学生记录：输入 ----
export interface CreateRecordInput {
  teacherId: string;
  studentId: string;
  category: StudentRecordCategory;
  summary: string;
  occurredAt?: Date;
  sourceRecordId?: string;
  structuredData?: Record<string, unknown>;
  confidence?: Confidence;
  visibility?: Visibility;
  importance?: Importance;
  source?: RecordSource;
}

// ---- 查询学生记录：输入 ----
export interface GetOwnedRecordInput {
  teacherId: string;
  recordId: string;
}

// ---- 按学生查询记录列表：输入 ----
export interface ListRecordsByStudentInput extends PaginationParams {
  teacherId: string;
  studentId: string;
}

// ---- 审核学生记录：输入 ----
export interface ReviewRecordInput {
  teacherId: string;
  studentId: string;
  recordId: string;
  reviewStatus: 'confirmed' | 'rejected';
  visibility?: Visibility;
  expectedUpdatedAt?: string;
  source?: RecordSource;
}

// ---- 取代学生记录：输入 ----
export interface SupersedeRecordInput {
  teacherId: string;
  recordId: string;
  replacement: {
    studentId?: string;
    category: StudentRecordCategory;
    summary: string;
    occurredAt?: Date;
    sourceRecordId?: string;
    structuredData?: Record<string, unknown>;
    confidence?: Confidence;
    visibility?: Visibility;
    importance?: Importance;
  };
}

// ---- 学生记录数据（与 Prisma 模型对应） ----
export interface StudentRecordData {
  id: string;
  teacherId: string;
  studentId: string;
  sourceRecordId: string | null;
  category: string;
  occurredAt: Date;
  summary: string;
  structuredData: Record<string, unknown> | null;
  confidence: string;
  reviewStatus: string;
  visibility: string;
  importance: string;
  supersedesId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---- 学生记录服务契约 ----
export interface StudentRecordsService {
  createRecord(input: CreateRecordInput): Promise<Result<StudentRecordData, CommonError>>;
  getOwnedRecord(input: GetOwnedRecordInput): Promise<Result<StudentRecordData, CommonError>>;
  listRecordsByStudent(
    input: ListRecordsByStudentInput,
  ): Promise<Result<{ items: StudentRecordData[]; total: number }, CommonError>>;
  reviewRecord(input: ReviewRecordInput): Promise<Result<StudentRecordData, CommonError>>;
  supersedeRecord(input: SupersedeRecordInput): Promise<Result<StudentRecordData, CommonError>>;
}
