import type { Result, CommonError, PaginationParams } from '@teacher-platform/contracts';

// ---- 日程类型 ----
export type ScheduleType = 'lesson' | 'prep' | 'meeting' | 'call' | 'other';

// ---- 日程状态（复用 state-machine 的定义） ----
export type { ScheduleStatus } from './state-machine.js';

// ---- 置信度 ----
export type Confidence = 'high' | 'medium' | 'low';

// ---- 创建日程：输入 ----
export interface CreateScheduleInput {
  teacherId: string;
  clientRequestId?: string;
  /** Legacy compatibility only. New lesson creation uses participantIds. */
  studentId?: string;
  participantIds?: string[];
  type: ScheduleType;
  title?: string;
  location?: string;
  classFormat?: 'one_to_one' | 'small_group';
  operationalNote?: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  confidence?: Confidence;
  pendingFields?: string[];
  sourceInput?: string;
}

// ---- 创建日程：输出 ----
export interface CreateScheduleResult {
  schedule: ScheduleData;
  conflicts: ScheduleData[];
}

// ---- 查询日程列表：输入 ----
export interface ListSchedulesInput extends PaginationParams {
  teacherId: string;
  studentId?: string;
  type?: ScheduleType;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface ListSchedulesStartingInWindowInput {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
}

export interface ListOverlappingSchedulesInput {
  teacherId: string;
  windowStart: Date;
  windowEndExclusive: Date;
  type: 'lesson';
}

export interface GetOwnedScheduleInput {
  teacherId: string;
  scheduleId: string;
}

// ---- 更新日程状态：输入 ----
export interface UpdateScheduleStatusInput {
  teacherId?: string;
  scheduleId: string;
  targetStatus: import('./state-machine.js').ScheduleStatus;
  newScheduleId?: string; // 改期时指向新日程
}

// ---- 取消/恢复日程：输入（D49）----
export interface CancelScheduleInput {
  teacherId: string;
  scheduleId: string;
}

export interface RestoreScheduleInput {
  teacherId: string;
  scheduleId: string;
}

// ---- 日程数据（与 Prisma 模型对应） ----
export interface ScheduleData {
  id: string;
  teacherId: string;
  studentId: string | null;
  participantIds: string[];
  type: string;
  /** Legacy storage field. New web projections must never render it. */
  title: string;
  location: string | null;
  classFormat: 'one_to_one' | 'small_group' | null;
  operationalNote: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
  confidence: string | null;
  pendingFields: unknown;
  sourceInput: string | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RescheduleLessonOwnerInput {
  teacherId: string;
  scheduleId: string;
  expectedUpdatedAt?: Date;
  replacement: {
    scheduledStart: Date;
    scheduledEnd: Date;
  };
}

export interface RescheduleLessonOwnerResult {
  beforeOriginal: ScheduleData;
  original: ScheduleData;
  replacement: ScheduleData;
  conflicts: ScheduleData[];
}

export interface ScheduleRescheduler {
  rescheduleLesson(
    input: RescheduleLessonOwnerInput,
  ): Promise<Result<RescheduleLessonOwnerResult, CommonError>>;
}

// ---- 接口契约 ----
export interface ScheduleService {
  createSchedule(input: CreateScheduleInput): Promise<Result<CreateScheduleResult, CommonError>>;
  getSchedule(scheduleId: string): Promise<Result<ScheduleData, CommonError>>;
  getOwnedSchedule(input: GetOwnedScheduleInput): Promise<Result<ScheduleData, CommonError>>;
  listSchedules(input: ListSchedulesInput): Promise<Result<{ items: ScheduleData[]; total: number }, CommonError>>;
  listSchedulesStartingInWindow(input: ListSchedulesStartingInWindowInput): Promise<Result<{ items: ScheduleData[]; total: number }, CommonError>>;
  listOverlappingSchedules(input: ListOverlappingSchedulesInput): Promise<Result<{ items: ScheduleData[]; total: number }, CommonError>>;
  updateScheduleStatus(input: UpdateScheduleStatusInput): Promise<Result<ScheduleData, CommonError>>;
  cancelSchedule(input: CancelScheduleInput): Promise<Result<ScheduleData, CommonError>>;
  restoreSchedule(input: RestoreScheduleInput): Promise<Result<ScheduleData, CommonError>>;
}
