import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';

// ---- 成绩明细数据（与 Prisma 模型 AssessmentDetail 对应） ----
export interface AssessmentDetailData {
  id: string;
  teacherId: string;
  studentRecordId: string;
  examName: string | null;
  subject: string | null;
  examDate: Date | null;
  score: number | null;
  fullScore: number | null;
  classRank: number | null;
  gradeRank: number | null;
  percentile: number | null;
  previousScore: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---- 学生长期资料库通用记录数据（与 Prisma 模型 StudentRecord 对应） ----
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

// ---- 成绩记录（record + detail 1:1 整体） ----
export interface ScoreRecordData {
  record: StudentRecordData;
  detail: AssessmentDetailData;
}

// ---- 创建成绩记录：输入 ----
export interface CreateScoreRecordInput {
  teacherId: string;
  studentId: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  examDate?: Date;
  previousScore?: number;
  note?: string;
  occurredAt?: Date;
  sourceText?: string;
  summaryOverride?: string;
}

// ---- 纠正成绩记录：输入 ----
export interface CorrectScoreRecordInput {
  teacherId: string;
  oldRecordId: string;
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  examDate?: Date;
  previousScore?: number;
  note?: string;
  occurredAt?: Date;
  sourceText?: string;
  summaryOverride?: string;
}

// ---- 按学生查询成绩列表：输入 ----
export interface ListByStudentInput extends PaginationParams {
  teacherId: string;
  studentId: string;
}

// ---- 查询归属明细：输入 ----
export interface GetOwnedDetailInput {
  teacherId: string;
  studentRecordId: string;
}

// ---- 接口契约 ----
export interface AssessmentService {
  createScoreRecord(input: CreateScoreRecordInput): Promise<Result<ScoreRecordData, CommonError>>;
  correctScoreRecord(input: CorrectScoreRecordInput): Promise<Result<ScoreRecordData, CommonError>>;
  listByStudent(input: ListByStudentInput): Promise<Result<{ items: ScoreRecordData[]; total: number }, CommonError>>;
  getOwnedDetail(input: GetOwnedDetailInput): Promise<Result<AssessmentDetailData, CommonError>>;
}
