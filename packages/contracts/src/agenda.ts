import type { ObjectReference, PresentationAction } from './presentation.js';

export type AgendaItemKind =
  | 'lesson'
  | 'memo'
  | 'payment_reminder'
  | 'feedback_followup'
  | 'pending_action'
  | 'custom_reminder';

export interface AgendaItem {
  id: string;
  kind: AgendaItemKind;
  title: string;
  startAt?: string;
  endAt?: string;
  allDay: boolean;
  status: string;
  studentRef?: ObjectReference;
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
