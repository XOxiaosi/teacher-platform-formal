import type { CommonError, Result } from '@teacher-platform/contracts';

export interface StudentTimelineRecordData {
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

export interface StudentTimelineAssessmentData {
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

export interface StudentTimelineLessonData {
  id: string;
  teacherId: string;
  studentId: string;
  scheduleId: string;
  date: Date;
  status: string;
  progress: string | null;
  studentState: string | null;
  homework: string | null;
  teacherNote: string | null;
  sourceNoteId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudentTimelineFeedbackData {
  id: string;
  teacherId: string;
  studentId: string;
  lessonId: string | null;
  title: string;
  content: string;
  status: 'draft' | 'reviewed' | 'sent' | 'archived';
  channel: string | null;
  parentName: string | null;
  sentAt: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TimelineEntryType = 'record' | 'assessment' | 'lesson' | 'feedback';

/**
 * 学生时间线中的一条聚合记录。
 *
 * 四个来源（学生记录 / 成绩 / 课次 / 家长反馈）共用同一扁平结构，
 * 用 `type` 区分来源；与来源无关的字段保持 null。
 */
export interface TimelineEntry {
  type: TimelineEntryType;
  id: string;
  occurredAt: Date;
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
  communicationDetail: {
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
  } | null;
  openTarget:
    | { type: 'record' | 'assessment'; recordId: string; sourceRecordId: string | null }
    | { type: 'lesson'; lessonId: string }
    | { type: 'feedback'; feedbackId: string };
}

export type StudentTimelineDetail =
  | { type: 'record'; record: StudentTimelineRecordData }
  | { type: 'assessment'; record: StudentTimelineRecordData; assessment: StudentTimelineAssessmentData }
  | { type: 'lesson'; lesson: StudentTimelineLessonData }
  | { type: 'feedback'; feedback: StudentTimelineFeedbackData };

export interface GetStudentTimelineInput {
  teacherId: string;
  studentId: string;
  limit?: number;
  page?: number;
  pageSize?: number;
  from?: Date;
  to?: Date;
  types?: TimelineEntryType[];
  categories?: string[];
}

export interface GetStudentTimelineDetailInput {
  teacherId: string;
  studentId: string;
  entryType: TimelineEntryType;
  entryId: string;
}

export interface StudentTimelineService {
  getStudentTimeline(
    input: GetStudentTimelineInput,
  ): Promise<Result<{ items: TimelineEntry[]; total: number; page: number; pageSize: number; hasMore: boolean }, CommonError>>;
  getStudentTimelineDetail(
    input: GetStudentTimelineDetailInput,
  ): Promise<Result<StudentTimelineDetail, CommonError>>;
}
