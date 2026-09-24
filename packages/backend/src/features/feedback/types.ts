import type { Prisma, PrismaClient } from '@prisma/client';
import type { CommonError, Result } from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import type { ChangelogFactory } from '../../shared/changelog/index.js';
import type { Logger } from '../../shared/logger/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';

export type FeedbackStatus = 'draft' | 'reviewed' | 'sent' | 'archived';

export type EvidenceType = 'assessment' | 'record' | 'lesson';

export interface FeedbackEvidenceSnapshotInput {
  id?: string;
  sourceVersion?: string;
  originalDeleted?: boolean;
  type: EvidenceType;
  occurredAt: string;
  category?: string | null;
  summary?: string | null;
  examName?: string | null;
  subject?: string | null;
  score?: number | null;
  fullScore?: number | null;
  previousScore?: number | null;
  parentConcerns?: string[] | null;
  followUps?: string[] | null;
}

export interface FeedbackSnapshotData {
  feedbackId: string;
  windowStart: string | null;
  windowEnd: string | null;
  assembledAt: string;
  evidence: FeedbackEvidenceSnapshotInput[];
}

export interface CreateFeedbackServiceOptions {
  prisma: PrismaClient | Prisma.TransactionClient;
  trustedClock?: TrustedClock;
  /** S3 平移：请求期解析 client（数据库路由）；未提供时回退装配期 prisma */
  getClient?: () => Promise<PrismaClient | Prisma.TransactionClient>;
  /**
   * 字段加密 cipher（P8 phase-3 批1）。缺省从 ENCRYPTION_KEY env 构建：
   * 未配置 → undefined（写路径 SAFETY_BLOCK 拒绝明文落库；读路径明文旧行直通双读）。
   * 测试必须注入（createFieldCipherFromEnv 或显式 cipher）。
   */
  cipher?: FieldCipher;
  /** 仅 provider=local 可接收解密后的出站反馈明文；其他 provider 由服务层强制忽略。 */
  moderation?: ModerationAdapter;
  /** 出站审核结构化日志；严禁记录 title/content。 */
  logger?: Logger;
  /** ParentFeedback create 显式同事务审计 factory；测试可注入失败实现。 */
  changelogFactory?: ChangelogFactory;
}

export interface ParentFeedbackData {
  id: string;
  teacherId: string;
  studentId: string;
  lessonId: string | null;
  title: string;
  content: string;
  status: FeedbackStatus;
  channel: string | null;
  parentName: string | null;
  sentAt: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
  createdAt: Date;
  updatedAt: Date;
  /** 首次保存返回 false，使用同一请求编号重放时返回 true。 */
  replayed?: boolean;
}

export interface CreateFeedbackInput {
  teacherId: string;
  studentId: string;
  lessonId?: string;
  title: string;
  content: string;
  channel?: string;
  parentName?: string;
  evidence?: FeedbackEvidenceSnapshotInput[];
  windowStart?: string;
  windowEnd?: string;
  /** 可选的租户内幂等请求编号（1-128 字符）。 */
  clientRequestId?: string;
  /** Durable generation task authority. When present, evidence is taken from the task. */
  generationTaskId?: string;
}

export type FeedbackDraftTaskStatus = 'running' | 'succeeded' | 'failed' | 'evidence_changed' | 'uncertain' | 'saved';

export type FeedbackDraftEvidence = Omit<FeedbackEvidenceSnapshotInput, 'id'> & { id: string };

export interface FeedbackDraftGeneration {
  lessonIds: string[];
  evidence: FeedbackDraftEvidence[];
  windowStart: string;
  windowEnd: string;
  rationale: string;
}

export interface FeedbackDraftContextExecutor {
  execute(input: {
    teacherId: string;
    studentId: string;
    lessonIds?: string[];
    recordIds?: string[];
  }): Promise<Result<{
    studentId: string;
    lessonIds?: string[];
    evidence: FeedbackDraftEvidence[];
    windowStart: string;
    windowEnd: string;
  }, CommonError>>;
}

export interface FeedbackDraftGeneratorExecutor {
  execute(input: {
    teacherId: string;
    studentId: string;
    lessonIds?: string[];
    recordIds?: string[];
    tone?: 'formal' | 'warm' | 'concise';
    classSize?: '1v1' | 'small' | 'large';
    parentType?: 'normal' | 'scores' | 'sensitive';
    focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
    runtime?: {
      taskId: string;
      executionId: string;
      contextEpoch: number;
      resume?: boolean;
    };
  }): Promise<Result<{
    studentId: string;
    lessonIds: string[];
    title: string;
    content: string;
    rationale: string;
    source: 'ai';
    evidence: FeedbackDraftEvidence[];
    windowStart: string;
    windowEnd: string;
  }, CommonError>>;
}

export interface FeedbackDraftTaskData {
  id: string;
  studentId: string;
  status: FeedbackDraftTaskStatus;
  version: number;
  attemptCount: number;
  retryable: boolean;
  request: Record<string, unknown>;
  draft: { title: string; content: string };
  generation: FeedbackDraftGeneration | null;
  error: { message: string; code?: string } | null;
  savedFeedbackId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFeedbackDraftTaskInput {
  teacherId: string;
  clientRequestId: string;
  studentId: string;
  lessonIds?: string[];
  recordIds?: string[];
  tone?: 'formal' | 'warm' | 'concise';
  classSize?: '1v1' | 'small' | 'large';
  parentType?: 'normal' | 'scores' | 'sensitive';
  focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  title?: string;
  content?: string;
}

export interface FeedbackDraftTaskService {
  create(input: CreateFeedbackDraftTaskInput): Promise<Result<{ task: FeedbackDraftTaskData; replayed: boolean }, CommonError>>;
  list(input: { teacherId: string; studentId?: string }): Promise<Result<{ items: FeedbackDraftTaskData[] }, CommonError>>;
  get(input: { teacherId: string; taskId: string }): Promise<Result<FeedbackDraftTaskData, CommonError>>;
  retry(input: { teacherId: string; taskId: string; clientRequestId: string; expectedVersion: number }): Promise<Result<{ task: FeedbackDraftTaskData; replayed: boolean }, CommonError>>;
  updateDraft(input: { teacherId: string; taskId: string; expectedVersion: number; title: string; content: string }): Promise<Result<FeedbackDraftTaskData, CommonError>>;
}

export interface GetFeedbackInput {
  teacherId: string;
  feedbackId: string;
}

export interface ListFeedbacksQuery {
  teacherId: string;
  studentId?: string;
  status?: FeedbackStatus;
  page?: number;
  pageSize?: number;
}

export interface UpdateFeedbackContentInput {
  teacherId: string;
  feedbackId: string;
  title?: string;
  content?: string;
}

export interface UpdateFeedbackStatusInput {
  teacherId: string;
  feedbackId: string;
  status: FeedbackStatus;
  sentAt?: string;
}

export interface ParentFeedbackContentChanges {
  title?: string;
  content?: string;
}

export interface UpdateParentFeedbackContentOwnerInput {
  teacherId: string;
  feedbackId: string;
  expectedUpdatedAt?: Date;
  changes: ParentFeedbackContentChanges;
}

export interface ParentFeedbackContentEditor {
  updateParentFeedbackContent(
    input: UpdateParentFeedbackContentOwnerInput,
  ): Promise<Result<{ before: ParentFeedbackData; after: ParentFeedbackData }, CommonError>>;
}

export interface FeedbackService {
  createFeedback(input: CreateFeedbackInput): Promise<Result<ParentFeedbackData, CommonError>>;
  getFeedback(input: GetFeedbackInput): Promise<Result<ParentFeedbackData, CommonError>>;
  listFeedbacks(input: ListFeedbacksQuery): Promise<Result<{ items: ParentFeedbackData[]; total: number }, CommonError>>;
  updateFeedbackContent(input: UpdateFeedbackContentInput): Promise<Result<ParentFeedbackData, CommonError>>;
  updateFeedbackStatus(input: UpdateFeedbackStatusInput): Promise<Result<ParentFeedbackData, CommonError>>;
  getFeedbackSnapshot(input: { teacherId: string; feedbackId: string }): Promise<Result<FeedbackSnapshotData, CommonError>>;
}
