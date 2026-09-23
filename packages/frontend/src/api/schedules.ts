import { apiRequest } from './client';
import type {
  ListResult,
  RescheduleLessonRequest,
  RescheduleLessonResult,
  ScheduleData,
} from './types';

interface ScheduleCreateBase {
  clientRequestId: string;
  scheduledStart: string;
  scheduledEnd: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface FormalLessonCreateRequest extends ScheduleCreateBase {
  type: 'lesson';
  participantIds: string[];
  location: string;
  classFormat: 'one_to_one' | 'small_group';
  operationalNote?: string;
  title?: never;
  studentId?: never;
}

export interface LegacyScheduleCreateRequest extends ScheduleCreateBase {
  type: 'prep' | 'meeting' | 'call' | 'other';
  title: string;
  studentId?: string;
  participantIds?: never;
  location?: never;
  classFormat?: never;
  operationalNote?: never;
}

export type CreateScheduleRequest = FormalLessonCreateRequest | LegacyScheduleCreateRequest;

export interface CreateScheduleResult {
  schedule: ScheduleData;
  conflicts: ScheduleData[];
}

export interface CompleteScheduleResult {
  schedule: ScheduleData;
  lesson: unknown;
  lessons?: unknown[];
}

export function listSchedules(teacherId: string): Promise<ListResult<ScheduleData>> {
  return apiRequest('/schedules', { teacherId });
}

export function createSchedule(teacherId: string, body: CreateScheduleRequest): Promise<CreateScheduleResult> {
  return apiRequest('/schedules', { method: 'POST', teacherId, body });
}

export function completeSchedule(teacherId: string, scheduleId: string): Promise<CompleteScheduleResult> {
  return apiRequest(`/schedules/${scheduleId}/complete`, { method: 'POST', teacherId, body: {} });
}

export function cancelSchedule(teacherId: string, scheduleId: string): Promise<ScheduleData> {
  return apiRequest(`/schedules/${encodeURIComponent(scheduleId)}/cancel`, { method: 'POST', teacherId, body: {} });
}

export function restoreSchedule(teacherId: string, scheduleId: string): Promise<ScheduleData> {
  return apiRequest(`/schedules/${encodeURIComponent(scheduleId)}/restore`, { method: 'POST', teacherId, body: {} });
}

export function rescheduleLesson(
  teacherId: string,
  scheduleId: string,
  body: RescheduleLessonRequest,
): Promise<RescheduleLessonResult> {
  return apiRequest(`/schedules/${encodeURIComponent(scheduleId)}/reschedule`, {
    method: 'POST',
    teacherId,
    body,
  });
}
