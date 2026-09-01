import type { Result, CommonError } from '@teacher-platform/contracts';

// ---- 枚举常量 ----
export const COMMUNICATION_DIRECTIONS = ['inbound', 'outbound', 'two_way'] as const;
export const COMMUNICATION_CHANNELS = ['phone', 'wechat', 'offline', 'other'] as const;
export const COMMUNICATION_PARENT_TYPES = ['normal', 'scores', 'sensitive'] as const;

export type CommunicationDirection = (typeof COMMUNICATION_DIRECTIONS)[number];
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];
export type CommunicationParentType = (typeof COMMUNICATION_PARENT_TYPES)[number];

// ---- 家长沟通明细数据（与 Prisma 模型 CommunicationDetail 对应） ----
export interface CommunicationDetailData {
  id: string;
  teacherId: string;
  studentRecordId: string;
  direction: string;
  channel: string | null;
  parentType: string | null;
  parentConcerns: string[];
  teacherResponses: string[];
  agreements: string[];
  followUps: string[];
  nextContactAtTs: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

// ---- 学生记录数据（复用自 student-records / assessments 的形状） ----
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

// ---- 创建家长沟通记录：输入 ----
export interface CreateCommunicationRecordInput {
  teacherId: string;
  studentId: string;
  occurredAt?: Date;
  summary: string;
  direction: CommunicationDirection;
  channel?: CommunicationChannel;
  parentType?: CommunicationParentType;
  parentConcerns?: string[];
  teacherResponses?: string[];
  agreements?: string[];
  followUps?: string[];
  nextContactAtTs?: Date;
  sourceText?: string;
  reviewStatus?: string;
  visibility?: string;
}

// ---- 更新家长沟通明细：输入 ----
export interface UpdateCommunicationDetailInput {
  teacherId: string;
  studentId: string;
  recordId: string;
  patch: {
    direction?: CommunicationDirection;
    channel?: CommunicationChannel | null;
    parentType?: CommunicationParentType | null;
    parentConcerns?: string[];
    teacherResponses?: string[];
    agreements?: string[];
    followUps?: string[];
    nextContactAtTs?: Date | null;
  };
}

// ---- 查询归属明细：输入 ----
export interface GetOwnedDetailInput {
  teacherId: string;
  studentId: string;
  recordId: string;
}

// ---- 接口契约 ----
export interface CommunicationService {
  createCommunicationRecord(
    input: CreateCommunicationRecordInput,
  ): Promise<Result<{ record: StudentRecordData; detail: CommunicationDetailData }, CommonError>>;
  updateDetail(input: UpdateCommunicationDetailInput): Promise<Result<CommunicationDetailData, CommonError>>;
  getOwnedDetail(input: GetOwnedDetailInput): Promise<Result<CommunicationDetailData, CommonError>>;
}
