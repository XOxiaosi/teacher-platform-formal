import { apiRequest, ApiError } from './client';
import type {
  EditReceipt,
  EditRequest,
  FeedbackContentChanges,
  ListResult,
  ParentFeedbackData,
} from './types';

export interface GenerateFeedbackDraftRequest {
  studentId: string;
  lessonIds?: string[];
  tone?: 'formal' | 'warm' | 'concise';
  classSize?: '1v1' | 'small' | 'large';
  parentType?: 'normal' | 'scores' | 'sensitive';
  focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
}

export interface FeedbackEvidenceItem {
  id: string;
  sourceVersion?: string;
  originalDeleted?: boolean;
  type: 'assessment' | 'record' | 'lesson';
  occurredAt: string;
  category: string | null;
  summary: string | null;
  examName: string | null;
  subject: string | null;
  score: number | null;
  fullScore: number | null;
  previousScore: number | null;
}

export interface GenerateFeedbackDraftResult {
  studentId: string;
  lessonIds: string[];
  title: string;
  content: string;
  source: 'ai';
  rationale: string;
  classSize?: '1v1' | 'small' | 'large';
  parentType?: 'normal' | 'scores' | 'sensitive';
  focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  evidence?: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
}

export function generateFeedbackDraft(
  teacherId: string,
  body: GenerateFeedbackDraftRequest,
): Promise<GenerateFeedbackDraftResult> {
  return apiRequest('/feedback/generate-draft', { method: 'POST', teacherId, body });
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
