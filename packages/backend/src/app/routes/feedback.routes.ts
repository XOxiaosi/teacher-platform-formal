import { Router } from 'express';
import { validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { FeedbackGenerateRouteDependencies } from '../composition/types.js';
import type {
  FeedbackDraftTone,
  FeedbackClassSize,
  FeedbackParentType,
  FeedbackFocus,
} from '../use-cases/generate-feedback-draft/types.js';
import type { CreateFeedbackInput, FeedbackStatus } from '../../features/feedback/types.js';
import {
  getTeacherId,
  sendResult,
  sendTeacherError,
} from './api-helpers.js';

const ALLOWED_TONES: ReadonlySet<string> = new Set(['formal', 'warm', 'concise']);
const ALLOWED_CLASS_SIZES: ReadonlySet<string> = new Set(['1v1', 'small', 'large']);
const ALLOWED_PARENT_TYPES: ReadonlySet<string> = new Set(['normal', 'scores', 'sensitive']);
const ALLOWED_FOCUSES: ReadonlySet<string> = new Set(['highlight', 'problem', 'cooperation', 'summary']);

export function createFeedbackRouter(dependencies: FeedbackGenerateRouteDependencies): Router {
  const router = Router();

  // 创建家长反馈（可带 evidence 快照）
  router.post('/feedback', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) {
      sendTeacherError(res, teacher.error);
      return;
    }

    const parsed = parseCreateFeedbackBody(req.body);
    if (!parsed.ok) {
      sendTeacherError(res, parsed.error);
      return;
    }

    const input: CreateFeedbackInput = {
      teacherId: teacher.value,
      studentId: parsed.value.studentId,
      title: parsed.value.title,
      content: parsed.value.content,
      lessonId: parsed.value.lessonId,
      channel: parsed.value.channel,
      parentName: parsed.value.parentName,
      clientRequestId: parsed.value.clientRequestId,
      evidence: parsed.value.evidence as CreateFeedbackInput['evidence'],
      windowStart: parsed.value.windowStart,
      windowEnd: parsed.value.windowEnd,
    };
    const result = await dependencies.feedbackService.createFeedback(input);
    sendResult(res, result, 201);
  });

  // 列出家长反馈
  router.get('/feedback', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) {
      sendTeacherError(res, teacher.error);
      return;
    }

    const parsed = parseListFeedbackQuery(req.query);
    if (!parsed.ok) {
      sendTeacherError(res, parsed.error);
      return;
    }

    const result = await dependencies.feedbackService.listFeedbacks({
      teacherId: teacher.value,
      ...parsed.value,
    });
    sendResult(res, result, 200);
  });

  // 查询反馈依据快照
  router.get('/feedback/:feedbackId/snapshot', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) {
      sendTeacherError(res, teacher.error);
      return;
    }

    const feedbackId = req.params.feedbackId;
    if (!feedbackId || typeof feedbackId !== 'string' || feedbackId.trim() === '') {
      sendTeacherError(res, validationError('feedbackId 不能为空', 'feedbackId'));
      return;
    }

    const result = await dependencies.feedbackService.getFeedbackSnapshot({
      teacherId: teacher.value,
      feedbackId,
    });
    sendResult(res, result, 200);
  });

  router.post('/feedback/generate-draft', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) {
      sendTeacherError(res, teacher.error);
      return;
    }

    const parsed = parseBody(req.body);
    if (!parsed.ok) {
      sendTeacherError(res, parsed.error);
      return;
    }

    const result = await dependencies.generateFeedbackDraft.execute({
      teacherId: teacher.value,
      studentId: parsed.value.studentId,
      lessonIds: parsed.value.lessonIds,
      recordIds: parsed.value.recordIds,
      tone: parsed.value.tone,
      classSize: parsed.value.classSize,
      parentType: parsed.value.parentType,
      focus: parsed.value.focus,
    });
    sendResult(res, result, 201);
  });

  return router;
}

function parseCreateFeedbackBody(body: unknown): Result<
  {
    studentId: string;
    title: string;
    content: string;
    lessonId?: string;
    channel?: string;
    parentName?: string;
    clientRequestId?: string;
    evidence?: unknown[];
    windowStart?: string;
    windowEnd?: string;
  },
  CommonError
> {
  const record = isPlainObject(body) ? (body as Record<string, unknown>) : {};

  const studentId = record.studentId;
  if (typeof studentId !== 'string' || studentId.trim() === '') {
    return { ok: false, error: validationError('studentId 必填', 'studentId') };
  }

  const title = record.title;
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, error: validationError('title 必填', 'title') };
  }

  const content = record.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, error: validationError('content 必填', 'content') };
  }

  const lessonId = record.lessonId;
  if (lessonId !== undefined && lessonId !== null && typeof lessonId !== 'string') {
    return { ok: false, error: validationError('lessonId 必须是字符串', 'lessonId') };
  }

  const channel = record.channel;
  if (channel !== undefined && channel !== null && typeof channel !== 'string') {
    return { ok: false, error: validationError('channel 必须是字符串', 'channel') };
  }

  const parentName = record.parentName;
  if (parentName !== undefined && parentName !== null && typeof parentName !== 'string') {
    return { ok: false, error: validationError('parentName 必须是字符串', 'parentName') };
  }

  const clientRequestId = record.clientRequestId;
  if (clientRequestId !== undefined && clientRequestId !== null
    && (typeof clientRequestId !== 'string' || clientRequestId.trim() === '' || clientRequestId.length > 128)) {
    return { ok: false, error: validationError('clientRequestId 必须是 1-128 个字符的非空字符串', 'clientRequestId') };
  }

  const evidence = record.evidence;
  if (evidence !== undefined && evidence !== null && !Array.isArray(evidence)) {
    return { ok: false, error: validationError('evidence 必须是数组', 'evidence') };
  }

  const windowStart = record.windowStart;
  if (windowStart !== undefined && windowStart !== null && typeof windowStart !== 'string') {
    return { ok: false, error: validationError('windowStart 必须是字符串', 'windowStart') };
  }

  const windowEnd = record.windowEnd;
  if (windowEnd !== undefined && windowEnd !== null && typeof windowEnd !== 'string') {
    return { ok: false, error: validationError('windowEnd 必须是字符串', 'windowEnd') };
  }

  return {
    ok: true,
    value: {
      studentId: studentId.trim(),
      title,
      content,
      lessonId: typeof lessonId === 'string' ? lessonId : undefined,
      channel: typeof channel === 'string' ? channel : undefined,
      parentName: typeof parentName === 'string' ? parentName : undefined,
      clientRequestId: typeof clientRequestId === 'string' ? clientRequestId.trim() : undefined,
      evidence: Array.isArray(evidence) ? evidence : undefined,
      windowStart: typeof windowStart === 'string' ? windowStart : undefined,
      windowEnd: typeof windowEnd === 'string' ? windowEnd : undefined,
    },
  };
}

function parseListFeedbackQuery(query: unknown): Result<
  {
    studentId?: string;
    status?: FeedbackStatus;
    page?: number;
    pageSize?: number;
  },
  CommonError
> {
  const record = isPlainObject(query) ? (query as Record<string, unknown>) : {};

  const studentId = record.studentId;
  if (studentId !== undefined && studentId !== null && (typeof studentId !== 'string' || studentId.trim() === '')) {
    return { ok: false, error: validationError('studentId 必须是非空字符串', 'studentId') };
  }

  let status: FeedbackStatus | undefined;
  if (record.status !== undefined && record.status !== null) {
    if (typeof record.status !== 'string' || !isFeedbackStatus(record.status)) {
      return { ok: false, error: validationError('status 不合法', 'status') };
    }
    status = record.status as FeedbackStatus;
  }

  let page: number | undefined;
  if (record.page !== undefined && record.page !== null) {
    const parsed = Number(record.page);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, error: validationError('page 必须是正整数', 'page') };
    }
    page = parsed;
  }

  let pageSize: number | undefined;
  if (record.pageSize !== undefined && record.pageSize !== null) {
    const parsed = Number(record.pageSize);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, error: validationError('pageSize 必须是正整数', 'pageSize') };
    }
    pageSize = parsed;
  }

  return {
    ok: true,
    value: {
      studentId: typeof studentId === 'string' ? studentId.trim() : undefined,
      status,
      page,
      pageSize,
    },
  };
}

function isFeedbackStatus(value: string): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

function parseBody(body: unknown): Result<
  {
    studentId: string;
    lessonIds?: string[];
    recordIds?: string[];
    tone?: FeedbackDraftTone;
    classSize?: FeedbackClassSize;
    parentType?: FeedbackParentType;
    focus?: FeedbackFocus;
  },
  CommonError
> {
  const record = isPlainObject(body) ? (body as Record<string, unknown>) : {};

  const studentId = record.studentId;
  if (typeof studentId !== 'string' || studentId.trim() === '') {
    return { ok: false, error: validationError('studentId 必填', 'studentId') };
  }

  const lessonIds = record.lessonIds;
  if (lessonIds !== undefined) {
    if (!Array.isArray(lessonIds) || lessonIds.some((id) => typeof id !== 'string')) {
      return { ok: false, error: validationError('lessonIds 必须是字符串数组', 'lessonIds') };
    }
  }

  const recordIds = record.recordIds;
  if (recordIds !== undefined) {
    if (!Array.isArray(recordIds) || recordIds.length === 0 || recordIds.some((id) => typeof id !== 'string' || id.trim() === '')
      || new Set(recordIds).size !== recordIds.length) {
      return { ok: false, error: validationError('recordIds 必须是非空且不重复的字符串数组', 'recordIds') };
    }
    if (lessonIds !== undefined) {
      return { ok: false, error: validationError('recordIds 不能与 lessonIds 同时使用', 'recordIds') };
    }
  }

  const tone = record.tone;
  if (tone !== undefined) {
    if (typeof tone !== 'string' || !ALLOWED_TONES.has(tone)) {
      return { ok: false, error: validationError('tone 不合法', 'tone') };
    }
  }

  const classSize = record.classSize;
  if (classSize !== undefined) {
    if (typeof classSize !== 'string' || !ALLOWED_CLASS_SIZES.has(classSize)) {
      return { ok: false, error: validationError('classSize 不合法', 'classSize') };
    }
  }

  const parentType = record.parentType;
  if (parentType !== undefined) {
    if (typeof parentType !== 'string' || !ALLOWED_PARENT_TYPES.has(parentType)) {
      return { ok: false, error: validationError('parentType 不合法', 'parentType') };
    }
  }

  const focus = record.focus;
  if (focus !== undefined) {
    if (typeof focus !== 'string' || !ALLOWED_FOCUSES.has(focus)) {
      return { ok: false, error: validationError('focus 不合法', 'focus') };
    }
  }

  return {
    ok: true,
    value: {
      studentId: studentId.trim(),
      lessonIds: lessonIds as string[] | undefined,
      recordIds: recordIds as string[] | undefined,
      tone: tone as FeedbackDraftTone | undefined,
      classSize: classSize as FeedbackClassSize | undefined,
      parentType: parentType as FeedbackParentType | undefined,
      focus: focus as FeedbackFocus | undefined,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
