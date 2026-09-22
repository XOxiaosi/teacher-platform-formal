import type { ObjectReference, PresentationAction } from './presentation.js';

export type AgendaItemKind =
  | 'lesson'
  | 'memo'
  | 'payment_reminder'
  | 'feedback_followup'
  | 'pending_action'
  | 'custom_reminder';

/**
 * 课程卡与摘要只使用这些工作信息，不承载课程标题、授课内容或教学目标。
 * 字段保持可选，旧日程在没有结构化信息时由界面明确显示“待补充”。
 */
export interface AgendaLessonDetails {
  location?: string;
  participantLabel?: string;
}

export interface AgendaItem {
  id: string;
  kind: AgendaItemKind;
  title: string;
  startAt?: string;
  endAt?: string;
  allDay: boolean;
  status: string;
  studentRef?: ObjectReference;
  lessonDetails?: AgendaLessonDetails;
  sourceRef: ObjectReference;
  actions: PresentationAction[];
}

export interface AgendaDay {
  date: string;
  items: AgendaItem[];
}

export interface AgendaTodayDocument {
  schemaVersion: 1;
  timeZone: 'Asia/Shanghai';
  businessDate: string;
  generatedAt: string;
  items: AgendaItem[];
}

export interface AgendaWeekDocument {
  schemaVersion: 1;
  timeZone: 'Asia/Shanghai';
  weekStart: string;
  weekEndExclusive: string;
  generatedAt: string;
  days: AgendaDay[];
}
