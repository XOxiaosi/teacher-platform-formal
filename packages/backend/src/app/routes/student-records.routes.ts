import { Router } from 'express';
import { validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type {
  Confidence,
  Importance,
  StudentRecordCategory,
  Visibility,
} from '../../features/student-records/index.js';
import type { CaptureScoreFromTextUseCase } from '../use-cases/capture-score-from-text/index.js';
import type { CaptureCommunicationFromTextUseCase } from '../use-cases/capture-communication-from-text/index.js';
import { getTeacherId, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';
import {
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_PARENT_TYPES,
} from '../../features/student-communications/index.js';

export interface StudentRecordsRouteDependencies {
  records: import('../../features/student-records/index.js').StudentRecordsService;
  sources: import('../../features/student-records/index.js').StudentSourceRecordService;
  assessments: import('../../features/assessments/index.js').AssessmentService;
  timeline: import('../../features/student-timeline/index.js').StudentTimelineService;
  captureScoreFromText?: CaptureScoreFromTextUseCase;
  communications: import('../../features/student-communications/types.js').CommunicationService;
  captureCommunicationFromText?: CaptureCommunicationFromTextUseCase;
}

const ALLOWED_REVIEW_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'rejected']);

interface CreateRecordBody { category: StudentRecordCategory; summary: string; occurredAt?: Date; structuredData?: Record<string, unknown>; confidence?: Confidence; visibility?: Visibility; importance?: Importance }
interface AssessmentBody { examName?: string; subject?: string; score?: number; fullScore?: number; examDate?: Date; note?: string; sourceText?: string; summaryOverride?: string }
interface CorrectBody extends AssessmentBody { oldRecordId: string }
interface ReviewBody { reviewStatus: 'confirmed' | 'rejected'; visibility?: Visibility; expectedUpdatedAt?: string }

export function createStudentRecordsRouter(dependencies: StudentRecordsRouteDependencies,
  options?: { legacyModelCaptureRoutesEnabled?: boolean }): Router {
  const router = Router();

  // 必须注册在 /students/:studentId/* 之前，避免被 :studentId 吞掉
  router.get('/students/sources/unresolved', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.sources.listUnresolvedSources({
      teacherId: teacher.value,
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.get('/students/:studentId/timeline', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.timeline.getStudentTimeline({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      limit: parseNumber(req.query.limit),
    });
    sendResult(res, result);
  });

  router.get('/students/:studentId/records', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const result = await dependencies.records.listRecordsByStudent({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      page: parseNumber(req.query.page),
      pageSize: parseNumber(req.query.pageSize),
    });
    sendResult(res, result);
  });

  router.post('/students/:studentId/records', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const body = parseCreateRecordBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);

    const result = await dependencies.records.createRecord({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      category: body.value.category,
      summary: body.value.summary,
      occurredAt: body.value.occurredAt,
      structuredData: body.value.structuredData,
      confidence: body.value.confidence,
      visibility: body.value.visibility,
      importance: body.value.importance,
      source: 'manual',
    });
    sendResult(res, result, 201);
  });

  router.post('/students/:studentId/assessments', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const body = parseAssessmentBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);

    const result = await dependencies.assessments.createScoreRecord({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      examName: body.value.examName,
      subject: body.value.subject,
      score: body.value.score,
      fullScore: body.value.fullScore,
      examDate: body.value.examDate,
      note: body.value.note,
      sourceText: body.value.sourceText,
      summaryOverride: body.value.summaryOverride,
    });
    sendResult(res, result, 201);
  });

  if (options?.legacyModelCaptureRoutesEnabled === true && dependencies.captureScoreFromText) {
    router.post('/students/:studentId/assessments/capture-from-text', async (req, res) => {
      const teacher = getTeacherId(req);
      if (!teacher.ok) return sendTeacherError(res, teacher.error);

      const body = parseCaptureFromTextBody(req.body);
      if (!body.ok) return sendTeacherError(res, body.error);

      const result = await dependencies.captureScoreFromText!.execute({
        teacherId: teacher.value,
        studentId: req.params.studentId,
        rawText: body.value.rawText,
        occurredAt: body.value.occurredAt,
      });
      sendResult(res, result, 201);
    });
  }

  router.post('/students/:studentId/assessments/correct', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const body = parseCorrectBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);

    const result = await dependencies.assessments.correctScoreRecord({
      teacherId: teacher.value,
      oldRecordId: body.value.oldRecordId,
      examName: body.value.examName,
      subject: body.value.subject,
      score: body.value.score,
      fullScore: body.value.fullScore,
      examDate: body.value.examDate,
      note: body.value.note,
      sourceText: body.value.sourceText,
      summaryOverride: body.value.summaryOverride,
    });
    sendResult(res, result, 201);
  });

  router.post('/students/:studentId/records/:recordId/review', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const body = parseReviewBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);

    const result = await dependencies.records.reviewRecord({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      recordId: req.params.recordId,
      reviewStatus: body.value.reviewStatus,
      visibility: body.value.visibility,
      expectedUpdatedAt: body.value.expectedUpdatedAt,
    });
    sendResult(res, result, 201);
  });

  if (options?.legacyModelCaptureRoutesEnabled === true && dependencies.captureCommunicationFromText) {
    router.post('/students/:studentId/communications/capture-from-text', async (req, res) => {
      const teacher = getTeacherId(req);
      if (!teacher.ok) return sendTeacherError(res, teacher.error);

      const body = parseCommunicationCaptureBody(req.body);
      if (!body.ok) return sendTeacherError(res, body.error);

      const result = await dependencies.captureCommunicationFromText!.execute({
        teacherId: teacher.value,
        studentId: req.params.studentId,
        rawText: body.value.rawText,
        occurredAt: body.value.occurredAt,
      });
      sendResult(res, result, 201);
    });
  }

  router.patch('/students/:studentId/communications/:recordId', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);

    const body = parseCommunicationPatchBody(req.body);
    if (!body.ok) return sendTeacherError(res, body.error);

    const result = await dependencies.communications.updateDetail({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      recordId: req.params.recordId,
      patch: body.value as Parameters<typeof dependencies.communications.updateDetail>[0]['patch'],
    });
    sendResult(res, result, 200);
  });

  return router;
}

// ---- body 解析 ----

function parseCreateRecordBody(body: unknown): Result<CreateRecordBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const category = requiredString(body.category, 'category');
  if (!category.ok) return category;
  const summary = requiredString(body.summary, 'summary');
  if (!summary.ok) return summary;

  const occurredAt = parseOptionalDate(body.occurredAt, 'occurredAt');
  if (!occurredAt.ok) return occurredAt;

  if (body.structuredData !== undefined && !isPlainObject(body.structuredData)) {
    return { ok: false, error: validationError('structuredData 必须是对象', 'structuredData') };
  }

  const confidence = optionalString(body.confidence, 'confidence');
  if (!confidence.ok) return confidence;
  const visibility = optionalString(body.visibility, 'visibility');
  if (!visibility.ok) return visibility;
  const importance = optionalString(body.importance, 'importance');
  if (!importance.ok) return importance;

  return {
    ok: true,
    value: {
      category: category.value as StudentRecordCategory,
      summary: summary.value,
      occurredAt: occurredAt.value,
      structuredData: body.structuredData as Record<string, unknown> | undefined,
      confidence: confidence.value as Confidence | undefined,
      visibility: visibility.value as Visibility | undefined,
      importance: importance.value as Importance | undefined,
    },
  };
}

function parseAssessmentBody(body: unknown): Result<AssessmentBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const score = parseOptionalNumber(body.score, 'score');
  if (!score.ok) return score;
  const fullScore = parseOptionalNumber(body.fullScore, 'fullScore');
  if (!fullScore.ok) return fullScore;
  const examDate = parseOptionalDate(body.examDate, 'examDate');
  if (!examDate.ok) return examDate;

  const examName = optionalString(body.examName, 'examName');
  if (!examName.ok) return examName;
  const subject = optionalString(body.subject, 'subject');
  if (!subject.ok) return subject;
  const note = optionalString(body.note, 'note');
  if (!note.ok) return note;
  const sourceText = optionalString(body.sourceText, 'sourceText');
  if (!sourceText.ok) return sourceText;
  const summaryOverride = optionalString(body.summaryOverride, 'summaryOverride');
  if (!summaryOverride.ok) return summaryOverride;

  return {
    ok: true,
    value: {
      examName: examName.value,
      subject: subject.value,
      score: score.value,
      fullScore: fullScore.value,
      examDate: examDate.value,
      note: note.value,
      sourceText: sourceText.value,
      summaryOverride: summaryOverride.value,
    },
  };
}

interface CaptureFromTextBody { rawText: string; occurredAt?: Date }

function parseCaptureFromTextBody(body: unknown): Result<CaptureFromTextBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const rawText = requiredString(body.rawText, 'rawText');
  if (!rawText.ok) return rawText;

  const occurredAt = parseOptionalDate(body.occurredAt, 'occurredAt');
  if (!occurredAt.ok) return occurredAt;

  return {
    ok: true,
    value: {
      rawText: rawText.value,
      occurredAt: occurredAt.value,
    },
  };
}

function parseCorrectBody(body: unknown): Result<CorrectBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const assessment = parseAssessmentBody(body);
  if (!assessment.ok) return assessment;

  const oldRecordId = requiredString(body.oldRecordId, 'oldRecordId');
  if (!oldRecordId.ok) return oldRecordId;

  return {
    ok: true,
    value: { ...assessment.value, oldRecordId: oldRecordId.value },
  };
}

function parseReviewBody(body: unknown): Result<ReviewBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const reviewStatus = body.reviewStatus;
  if (typeof reviewStatus !== 'string' || !ALLOWED_REVIEW_STATUSES.has(reviewStatus)) {
    return {
      ok: false,
      error: validationError('reviewStatus 必须是 confirmed 或 rejected', 'reviewStatus'),
    };
  }

  const visibility = optionalString(body.visibility, 'visibility');
  if (!visibility.ok) return visibility;

  const expectedUpdatedAt = optionalString(body.expectedUpdatedAt, 'expectedUpdatedAt');
  if (!expectedUpdatedAt.ok) return expectedUpdatedAt;

  return {
    ok: true,
    value: {
      reviewStatus: reviewStatus as 'confirmed' | 'rejected',
      visibility: visibility.value as Visibility | undefined,
      expectedUpdatedAt: expectedUpdatedAt.value,
    },
  };
}

// ---- 沟通 capture 解析 ----

interface CommunicationCaptureBody { rawText: string; occurredAt?: Date }

function parseCommunicationCaptureBody(body: unknown): Result<CommunicationCaptureBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const rawText = requiredString(body.rawText, 'rawText');
  if (!rawText.ok) return rawText;

  const occurredAt = parseOptionalDate(body.occurredAt, 'occurredAt');
  if (!occurredAt.ok) return occurredAt;

  return {
    ok: true,
    value: {
      rawText: rawText.value,
      occurredAt: occurredAt.value,
    },
  };
}

// ---- 沟通 patch 解析 ----

interface CommunicationPatchBody { direction?: string; channel?: string | null; parentType?: string | null; parentConcerns?: string[]; teacherResponses?: string[]; agreements?: string[]; followUps?: string[]; nextContactAtTs?: Date | null }

function parseCommunicationPatchBody(body: unknown): Result<CommunicationPatchBody, CommonError> {
  if (!isPlainObject(body)) {
    return { ok: false, error: validationError('请求体必须是对象', 'body') };
  }

  const direction = optionalString(body.direction, 'direction');
  if (!direction.ok) return direction;
  if (direction.value !== undefined && !COMMUNICATION_DIRECTIONS.includes(direction.value as any)) {
    return { ok: false, error: validationError('direction 不合法', 'direction') };
  }

  // channel: 允许 null 或合法字符串，不提供则为 undefined
  if (body.channel !== undefined) {
    if (body.channel === null) {
      // 保留为 null
    } else if (typeof body.channel !== 'string' || !COMMUNICATION_CHANNELS.includes(body.channel as any)) {
      return { ok: false, error: validationError('channel 不合法', 'channel') };
    }
  }

  // parentType: 允许 null 或合法字符串
  if (body.parentType !== undefined) {
    if (body.parentType === null) {
      // 保留为 null
    } else if (typeof body.parentType !== 'string' || !COMMUNICATION_PARENT_TYPES.includes(body.parentType as any)) {
      return { ok: false, error: validationError('parentType 不合法', 'parentType') };
    }
  }

  if (body.parentConcerns !== undefined && !isStringArray(body.parentConcerns)) {
    return { ok: false, error: validationError('parentConcerns 必须是字符串数组', 'parentConcerns') };
  }
  if (body.teacherResponses !== undefined && !isStringArray(body.teacherResponses)) {
    return { ok: false, error: validationError('teacherResponses 必须是字符串数组', 'teacherResponses') };
  }
  if (body.agreements !== undefined && !isStringArray(body.agreements)) {
    return { ok: false, error: validationError('agreements 必须是字符串数组', 'agreements') };
  }
  if (body.followUps !== undefined && !isStringArray(body.followUps)) {
    return { ok: false, error: validationError('followUps 必须是字符串数组', 'followUps') };
  }

  // nextContactAt: 允许合法 RFC3339 字符串、null；不提供则为 undefined
  let nextContactAtTs: Date | null | undefined;
  if (body.nextContactAt !== undefined) {
    if (body.nextContactAt === null) {
      nextContactAtTs = null;
    } else {
      const parsed = parseOptionalDate(body.nextContactAt, 'nextContactAt');
      if (!parsed.ok) return parsed;
      nextContactAtTs = parsed.value ?? null;
    }
  }

  return {
    ok: true,
    value: {
      direction: direction.value,
      channel: body.channel as string | null | undefined,
      parentType: body.parentType as string | null | undefined,
      parentConcerns: body.parentConcerns as string[] | undefined,
      teacherResponses: body.teacherResponses as string[] | undefined,
      agreements: body.agreements as string[] | undefined,
      followUps: body.followUps as string[] | undefined,
      nextContactAtTs,
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ---- 基础校验 ----

function requiredString(value: unknown, field: string): Result<string, CommonError> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: validationError(`${field} 必填`, field) };
  }
  return { ok: true, value };
}

function optionalString(value: unknown, field: string): Result<string | undefined, CommonError> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, error: validationError(`${field} 必须是字符串`, field) };
  }
  return { ok: true, value };
}

function parseOptionalNumber(
  value: unknown,
  field: string,
): Result<number | undefined, CommonError> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: validationError(`${field} 必须是数字`, field) };
  }
  return { ok: true, value };
}

function parseOptionalDate(
  value: unknown,
  field: string,
): Result<Date | undefined, CommonError> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: validationError(`${field} 必须是带时区的 RFC3339 字符串`, field) };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { ok: false, error: validationError(`${field} 不是有效日期`, field) };
  }
  return { ok: true, value: new Date(parsed) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
