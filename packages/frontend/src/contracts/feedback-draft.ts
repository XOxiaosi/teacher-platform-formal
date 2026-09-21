export interface GenerateFeedbackDraftRequest {
  studentId: string;
  lessonIds?: string[];
  recordIds?: string[];
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

export type FeedbackDraftTaskStatus = 'running' | 'succeeded' | 'failed' | 'evidence_changed' | 'uncertain' | 'saved';

export interface FeedbackDraftTaskRequest extends GenerateFeedbackDraftRequest {
  clientRequestId?: string;
  title?: string;
  content?: string;
}

export interface FeedbackDraftTaskGeneration {
  lessonIds: string[];
  rationale: string;
  classSize?: '1v1' | 'small' | 'large';
  parentType?: 'normal' | 'scores' | 'sensitive';
  focus?: 'highlight' | 'problem' | 'cooperation' | 'summary';
  evidence?: FeedbackEvidenceItem[];
  windowStart?: string;
  windowEnd?: string;
}

export interface FeedbackDraftTask {
  id: string;
  studentId: string;
  status: FeedbackDraftTaskStatus;
  version: number;
  attemptCount: number;
  retryable: boolean;
  request: FeedbackDraftTaskRequest;
  draft: { title: string; content: string } | null;
  generation: FeedbackDraftTaskGeneration | null;
  error: { code?: string; message: string; field?: string } | null;
  savedFeedbackId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFeedbackDraftTaskBody extends GenerateFeedbackDraftRequest {
  clientRequestId: string;
  title?: string;
  content?: string;
}

export interface FeedbackDraftTaskReceipt {
  task: FeedbackDraftTask;
  replayed: boolean;
}

export interface RetryFeedbackDraftTaskBody {
  clientRequestId: string;
  expectedVersion: number;
}

export interface UpdateFeedbackDraftTaskBody {
  expectedVersion: number;
  title: string;
  content: string;
}
