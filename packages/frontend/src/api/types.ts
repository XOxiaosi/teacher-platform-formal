import type { LessonBalance } from './lesson-ledger-types';

export type {
  ConfirmLessonLedgerAdjustmentResult,
  LessonBalance,
  LessonLedgerAdjustmentConfirmationData,
  LessonLedgerAdjustmentEntryType,
  LessonLedgerEntryData,
  PrepareLessonLedgerAdjustmentRequest,
  PrepareLessonLedgerAdjustmentResult,
} from './lesson-ledger-types';

export type CommonErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'ALREADY_CONSUMED'
  | 'VERSION_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED';

export interface CommonError {
  code: CommonErrorCode;
  message: string;
  field?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: CommonError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface ListResult<T> {
  items: T[];
  total: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EditReceipt<T> {
  value: T;
  changeLogId: string;
}

export interface EditRequest<TChanges> {
  expectedUpdatedAt: string;
  changes: TChanges;
}

export interface StudentData {
  id: string;
  teacherId: string;
  name: string;
  grade: string;
  source: string | null;
  currentStatus: string;
  stageGoal: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleData {
  id: string;
  teacherId: string;
  studentId: string | null;
  type: string;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  confidence: string | null;
  pendingFields: JsonValue | null;
  sourceInput: string | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  location?: string | null;
  classFormat?: 'one_to_one' | 'small_group' | null;
  operationalNote?: string | null;
  participantIds?: string[];
  participants?: Array<{ id: string; name: string }>;
}

export interface PaymentData {
  id: string;
  teacherId: string;
  studentId: string;
  amount: number;
  lessonCount: number;
  paidAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LessonData {
  id: string;
  teacherId: string;
  studentId: string;
  scheduleId: string;
  date: string;
  status: string;
  progress: string | null;
  studentState: string | null;
  homework: string | null;
  teacherNote: string | null;
  sourceNoteId: string | null;
  createdAt: string;
  updatedAt: string;
  location?: string | null;
  classFormat?: 'one_to_one' | 'small_group' | null;
  operationalNote?: string | null;
  participantIds?: string[];
  participants?: Array<{ id: string; name: string }>;
}

export interface MemoData {
  id: string;
  teacherId: string;
  title: string;
  content: string;
  status: 'active' | 'done' | 'archived';
  dueAt: string | null;
  tags: JsonValue | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParentFeedbackData {
  id: string;
  teacherId: string;
  studentId: string;
  lessonId: string | null;
  title: string;
  content: string;
  status: 'draft' | 'reviewed' | 'sent' | 'archived';
  channel: string | null;
  parentName: string | null;
  sentAt: string | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudentProfileChanges {
  name?: string;
  grade?: string;
  source?: string | null;
  stageGoal?: string | null;
}

export interface LessonRecordChanges {
  progress?: string | null;
  studentState?: string | null;
  homework?: string | null;
  teacherNote?: string | null;
}

export interface PaymentChanges {
  amount?: number;
  lessonCount?: number;
  paidAt?: string;
  note?: string | null;
}

export interface MemoChanges {
  title?: string;
  content?: string;
  dueAt?: string | null;
  tags?: JsonValue | null;
}

export interface FeedbackContentChanges {
  title?: string;
  content?: string;
}

export interface RescheduleLessonRequest {
  expectedUpdatedAt: string;
  replacement: {
    scheduledStart: string;
    scheduledEnd: string;
  };
}

export interface RescheduleLessonResult {
  original: ScheduleData;
  replacement: ScheduleData;
  conflicts: ScheduleData[];
  changeLogIds: {
    original: string;
    replacement: string;
  };
}

export interface StudentProfileView {
  student: StudentData;
  recentSchedules: ScheduleData[];
  lessonHistory: unknown[];
  lessonBalance: LessonBalance;
}

export interface DailyReviewResult {
  review: Record<string, unknown>;
  schedules: ScheduleData[];
  lessons: unknown[];
}

export interface AiRawInputResult {
  noteId: string;
  rawInput: string;
  audioFileRef: string | null;
  savedNote: Record<string, unknown>;
}

// ---- 学生时间线 ----
export type TimelineEntryType = 'record' | 'assessment' | 'lesson' | 'feedback';

export interface TimelineCommunicationDetail {
  direction: string;
  channel: string | null;
  parentType: string | null;
  parentConcerns: string[];
  teacherResponses: string[];
  agreements: string[];
  followUps: string[];
  nextContactAtTs: string | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
}

export interface TimelineEntry {
  type: TimelineEntryType;
  id: string;
  occurredAt: string;
  title: string;
  summary: string | null;
  category: string | null;
  reviewStatus: string | null;
  visibility: string | null;
  status: string | null;
  score: number | null;
  fullScore: number | null;
  examName: string | null;
  subject: string | null;
  communicationDetail: TimelineCommunicationDetail | null;
}

// ---- 学生档案记录 ----
export interface StudentRecordItem {
  id: string;
  teacherId: string;
  studentId: string;
  sourceRecordId: string | null;
  category: string;
  occurredAt: string;
  summary: string;
  structuredData: Record<string, unknown> | null;
  confidence: string;
  reviewStatus: string;
  visibility: string;
  importance: string;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- 成绩明细 ----
export interface StudentRecordSource {
  recordId: string;
  state: 'available' | 'none' | 'deleted' | 'unavailable';
  source: null | {
    id: string;
    sourceType: string;
    captureStatus: string;
    rawText: string | null;
    occurredAt: string;
    updatedAt: string;
  };
}

export interface AssessmentDetailData {
  id: string;
  teacherId: string;
  studentRecordId: string;
  examName: string | null;
  subject: string | null;
  examDate: string | null;
  score: number | null;
  fullScore: number | null;
  classRank: number | null;
  gradeRank: number | null;
  percentile: number | null;
  previousScore: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreRecordData {
  record: StudentRecordItem;
  detail: AssessmentDetailData;
}

// ---- 文字记成绩（识别+归档） ----
export interface ScoreExtraction {
  examName?: string;
  subject?: string;
  score?: number;
  fullScore?: number;
  previousScore?: number;
  examDate?: string;
  note?: string;
  confidence?: string;
}

export interface CaptureScoreFromTextResult {
  studentId: string;
  extraction: ScoreExtraction;
  record: StudentRecordItem;
  detail: AssessmentDetailData;
  sourceRecord: {
    id: string;
    rawText: string | null;
    captureStatus: string;
  };
}

// ---- 家长沟通明细 ----
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
  nextContactAtTs: string | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
  createdAtTs: string;
  updatedAtTs: string;
}

export interface CommunicationExtraction {
  direction?: string | null;
  channel?: string | null;
  parentType?: string | null;
  parentConcerns?: string[] | null;
  teacherResponses?: string[] | null;
  agreements?: string[] | null;
  followUps?: string[] | null;
  nextContactAt?: string | null;
  summary?: string | null;
  confidence?: string | null;
}

export interface CaptureCommunicationResult {
  studentId: string;
  extraction: CommunicationExtraction;
  record: StudentRecordItem;
  detail: CommunicationDetailData;
  sourceRecord: { id: string } | null;
}

export interface CommunicationDetailPatch {
  direction?: string;
  channel?: string | null;
  parentType?: string | null;
  parentConcerns?: string[];
  teacherResponses?: string[];
  agreements?: string[];
  followUps?: string[];
  nextContactAt?: string | null;
}

// ---- LLM Provider 配置（P8 · LLM 配置 UI，契约 p7-llm-provider-design.md §2.2/§4.2） ----
export type ProviderConfigKind = 'openai' | 'anthropic';

/** 配置路由 DTO：绝不含 apiKeyEnc / 明文，只有 apiKeyMasked。 */
export interface ProviderConfigDto {
  id: string;
  providerKind: ProviderConfigKind;
  providerName: string;
  displayName: string | null;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  isPrimary: boolean;
  status: string;
  createdAtTs: string;
  updatedAtTs: string;
}

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'invalid_request'
  | 'provider_down'
  | 'model_not_found'
  | 'unknown';

/** POST /:id/test 返回：探针 ok 或 ProviderError kind（不耗真实业务预算）。 */
export interface ProviderTestResult {
  ok: boolean;
  providerName?: string;
  model?: string;
  providerError?: {
    kind: ProviderErrorKind;
    status: number;
    message: string;
    retryable: boolean;
  };
}

export interface UsageSummaryRow {
  providerName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

/** GET /usage/summary?from&to 按教师聚合（owner 隔离）。 */
export interface UsageSummary {
  from: string;
  to: string;
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
  };
  byProvider: UsageSummaryRow[];
}
