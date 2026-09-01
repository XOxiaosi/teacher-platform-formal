import type { CommonError, Result } from '@teacher-platform/contracts';

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
}

export interface GetStudentTimelineInput {
  teacherId: string;
  studentId: string;
  limit?: number;
}

export interface StudentTimelineService {
  getStudentTimeline(
    input: GetStudentTimelineInput,
  ): Promise<Result<{ items: TimelineEntry[]; total: number }, CommonError>>;
}
