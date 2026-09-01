import { apiRequest } from './client';
import type {
  ListResult,
  RescheduleLessonRequest,
  RescheduleLessonResult,
  ScheduleData,
} from './types';

export interface CreateScheduleRequest {
  studentId?: string;
  type: 'lesson' | 'prep' | 'meeting' | 'call' | 'other';
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface CreateScheduleResult {
  schedule: ScheduleData;
  conflicts: ScheduleData[];
}

export interface CompleteScheduleResult {
  schedule: ScheduleData;
  lesson: unknown;
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
