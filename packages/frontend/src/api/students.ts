import { apiRequest } from './client';
import type {
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
  StudentRecordSource,
  StudentTimelineQuery,
  StudentTimelineResult,
  TimelineEntryDetail,
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
  options: StudentTimelineQuery | number = {},
): Promise<StudentTimelineResult> {
  const normalized: StudentTimelineQuery = typeof options === 'number'
    ? { page: 1, pageSize: options }
    : options;
  const query = new URLSearchParams();
  if (normalized.page !== undefined) query.set('page', String(normalized.page));
  if (normalized.pageSize !== undefined) query.set('pageSize', String(normalized.pageSize));
  if (normalized.from !== undefined) query.set('from', normalized.from);
  if (normalized.to !== undefined) query.set('to', normalized.to);
  normalized.types?.forEach((type) => query.append('types', type));
  normalized.categories?.forEach((category) => query.append('categories', category));
  return apiRequest(`/students/${encodeURIComponent(studentId)}/timeline${query.size ? `?${query}` : ''}`, {
    teacherId,
  });
}

export function getStudentTimelineDetail(
  teacherId: string,
  studentId: string,
  entryType: TimelineEntry['type'],
  entryId: string,
): Promise<TimelineEntryDetail> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/timeline/${encodeURIComponent(entryType)}/${encodeURIComponent(entryId)}/detail`, {
    teacherId,
  });
}

export function listStudentRecords(
  teacherId: string,
  studentId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<ListResult<StudentRecordItem>> {
  const query = new URLSearchParams();
  if (options.page !== undefined) query.set('page', String(options.page));
  if (options.pageSize !== undefined) query.set('pageSize', String(options.pageSize));
  return apiRequest(`/students/${encodeURIComponent(studentId)}/records${query.size ? `?${query}` : ''}`, {
    teacherId,
  });
}

export function reviewStudentRecord(
  teacherId: string,
  studentId: string,
  recordId: string,
  reviewStatus: 'confirmed' | 'rejected',
  visibility?: string,
  expectedUpdatedAt?: string,
): Promise<StudentRecordItem> {
  const body: Record<string, string> = { reviewStatus };
  if (visibility !== undefined) {
    body.visibility = visibility;
  }
  if (expectedUpdatedAt !== undefined) body.expectedUpdatedAt = expectedUpdatedAt;
  return apiRequest(`/students/${encodeURIComponent(studentId)}/records/${encodeURIComponent(recordId)}/review`, {
    method: 'POST',
    teacherId,
    body,
  });
}

export function getStudentRecordSource(
  teacherId: string, studentId: string, recordId: string,
): Promise<StudentRecordSource> {
  return apiRequest(`/students/${encodeURIComponent(studentId)}/records/${encodeURIComponent(recordId)}/source`, { teacherId });
}

// ---- 家长沟通 ----

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
