import { apiRequest, ApiError } from './client';
import type {
  EditReceipt,
  EditRequest,
  FeedbackContentChanges,
  ListResult,
  ParentFeedbackData,
} from './types';
import type {
  CreateFeedbackDraftTaskBody,
  FeedbackDraftTask,
  FeedbackDraftTaskReceipt,
  FeedbackEvidenceItem,
  RetryFeedbackDraftTaskBody,
  UpdateFeedbackDraftTaskBody,
} from '../contracts/feedback-draft';
export type {
  CreateFeedbackDraftTaskBody,
  FeedbackDraftTask,
  FeedbackDraftTaskGeneration,
  FeedbackDraftTaskReceipt,
  FeedbackDraftTaskRequest,
  FeedbackDraftTaskStatus,
  FeedbackEvidenceItem,
  RetryFeedbackDraftTaskBody,
  UpdateFeedbackDraftTaskBody,
} from '../contracts/feedback-draft';

export function createFeedbackDraftTask(
  teacherId: string,
  body: CreateFeedbackDraftTaskBody,
): Promise<FeedbackDraftTaskReceipt> {
  return apiRequest('/feedback/draft-tasks', { method: 'POST', teacherId, body });
}

export function listFeedbackDraftTasks(
  teacherId: string,
  studentId?: string,
): Promise<{ items: FeedbackDraftTask[] }> {
  const query = studentId ? `?studentId=${encodeURIComponent(studentId)}` : '';
  return apiRequest(`/feedback/draft-tasks${query}`, { method: 'GET', teacherId });
}

export function getFeedbackDraftTask(
  teacherId: string,
  taskId: string,
): Promise<FeedbackDraftTask> {
  return apiRequest(`/feedback/draft-tasks/${encodeURIComponent(taskId)}`, { method: 'GET', teacherId });
}

export function retryFeedbackDraftTask(
  teacherId: string,
  taskId: string,
  body: RetryFeedbackDraftTaskBody,
): Promise<FeedbackDraftTaskReceipt> {
  return apiRequest(`/feedback/draft-tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST', teacherId, body });
}

export function updateFeedbackDraftTask(
  teacherId: string,
  taskId: string,
  body: UpdateFeedbackDraftTaskBody,
): Promise<FeedbackDraftTask> {
  return apiRequest(`/feedback/draft-tasks/${encodeURIComponent(taskId)}/draft`, { method: 'PATCH', teacherId, body });
}

export function updateFeedbackContent(
  teacherId: string,
  feedbackId: string,
  body: EditRequest<FeedbackContentChanges>,
): Promise<EditReceipt<ParentFeedbackData>> {
  return apiRequest(`/feedback/${encodeURIComponent(feedbackId)}/content`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}

// ---- 保存与列表 ----

export interface SavedFeedback {
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

export interface FeedbackSnapshotData {
  feedbackId: string;
  windowStart: string | null;
  windowEnd: string | null;
  assembledAt: string;
  evidence: FeedbackEvidenceItem[];
}

export interface CreateFeedbackBody {
  studentId: string;
  title: string;
  content: string;
  /** 租户内幂等请求编号；显式保存时由正式入口生成。 */
  clientRequestId?: string;
  lessonId?: string;
  channel?: string;
  parentName?: string;
  evidence?: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
  /** 持久化生成任务存在时，服务端从任务的冻结依据生成快照。 */
  generationTaskId?: string;
}

export function createFeedback(
  teacherId: string,
  body: CreateFeedbackBody,
): Promise<SavedFeedback> {
  return apiRequest('/feedback', { method: 'POST', teacherId, body });
}

export interface ListFeedbacksParams {
  studentId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export function listFeedbacks(
  teacherId: string,
  params?: ListFeedbacksParams,
): Promise<ListResult<SavedFeedback>> {
  const search = new URLSearchParams();
  if (params?.studentId) search.set('studentId', params.studentId);
  if (params?.status) search.set('status', params.status);
  if (params?.page !== undefined) search.set('page', String(params.page));
  if (params?.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  const qs = search.toString();
  return apiRequest(`/feedback${qs ? `?${qs}` : ''}`, { method: 'GET', teacherId });
}

export async function getFeedbackSnapshot(
  teacherId: string,
  feedbackId: string,
): Promise<FeedbackSnapshotData> {
  try {
    return await apiRequest<FeedbackSnapshotData>(
      `/feedback/${encodeURIComponent(feedbackId)}/snapshot`,
      { method: 'GET', teacherId },
    );
  } catch (error) {
    if (error instanceof ApiError && error.error.code === 'NOT_FOUND') {
      throw new Error('此条没有依据快照');
    }
    throw error;
  }
}
