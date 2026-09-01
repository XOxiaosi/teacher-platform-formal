import { apiRequest } from './client';
import type {
  CaptureCommunicationResult,
  CaptureScoreFromTextResult,
  CommunicationDetailData,
  CommunicationDetailPatch,
  EditReceipt,
  EditRequest,
  LessonBalance,
  ListResult,
  StudentData,
  StudentProfileChanges,
  StudentProfileView,
  StudentRecordItem,
  TimelineEntry,
} from './types';

export interface CreateStudentRequest {
  name: string;
  grade: string;
  source?: string;
  stageGoal?: string;
}

export function listStudents(teacherId: string): Promise<ListResult<StudentData>> {
  return apiRequest('/students', { teacherId });
}

export function createStudent(teacherId: string, body: CreateStudentRequest): Promise<StudentData> {
  return apiRequest('/students', { method: 'POST', teacherId, body });
}

export function getStudentProfile(teacherId: string, studentId: string): Promise<StudentProfileView> {
  return apiRequest(`/students/${studentId}/profile`, { teacherId });
}

export function getStudentBalance(teacherId: string, studentId: string): Promise<LessonBalance> {
  return apiRequest(`/students/${studentId}/balance`, { teacherId });
}

export function updateStudentProfile(
  teacherId: string,
  studentId: string,
  body: EditRequest<StudentProfileChanges>,
): Promise<EditReceipt<StudentData>> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/profile`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}

// ---- 学生详情页新增接口 ----

export function getStudentTimeline(
  teacherId: string,
  studentId: string,
  limit = 200,
): Promise<ListResult<TimelineEntry>> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/timeline?limit=${limit}`, {
    teacherId,
  });
}

export function listStudentRecords(
  teacherId: string,
  studentId: string,
): Promise<ListResult<StudentRecordItem>> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/records`, {
    teacherId,
  });
}

export function reviewStudentRecord(
  teacherId: string,
  studentId: string,
  recordId: string,
  reviewStatus: 'confirmed' | 'rejected',
  visibility?: string,
): Promise<StudentRecordItem> {
  const body: Record<string, string> = { reviewStatus };
  if (visibility !== undefined) {
    body.visibility = visibility;
  }
  return apiRequest(`/students/${encodeURIComponent(studentId)}/records/${encodeURIComponent(recordId)}/review`, {
    method: 'POST',
    teacherId,
    body,
  });
}

export function captureScoreFromText(
  teacherId: string,
  studentId: string,
  rawText: string,
): Promise<CaptureScoreFromTextResult> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/assessments/capture-from-text`, {
    method: 'POST',
    teacherId,
    body: { rawText },
  });
}

// ---- 家长沟通 ----

export function captureCommunicationFromText(
  teacherId: string,
  studentId: string,
  body: { rawText: string; occurredAt?: string },
): Promise<CaptureCommunicationResult> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/communications/capture-from-text`, {
    method: 'POST',
    teacherId,
    body,
  });
}

export function updateCommunicationDetail(
  teacherId: string,
  studentId: string,
  recordId: string,
  patch: CommunicationDetailPatch,
): Promise<CommunicationDetailData> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/communications/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    teacherId,
    body: patch,
  });
}
