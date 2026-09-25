import type { PrismaClient } from '@prisma/client';
import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  StudentTimelineAssessmentData,
  StudentTimelineFeedbackData,
  StudentTimelineLessonData,
  StudentTimelineRecordData,
  StudentTimelineService,
  TimelineEntry,
  TimelineEntryType,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TIMELINE_CATEGORIES = new Set([
  'assessment', 'lesson_observation', 'parent_communication', 'learning_state', 'homework',
  'goal', 'achievement', 'concern', 'agreement', 'follow_up', 'general_note',
]);
const TIMELINE_TYPE_ORDER: Record<TimelineEntryType, number> = {
  record: 1,
  assessment: 2,
  lesson: 3,
  feedback: 4,
};

type StudentTimelinePrismaClient = PrismaClient;

interface RecordLike {
  id: string;
  teacherId: string;
  studentId: string;
  sourceRecordId: string | null;
  category: string;
  occurredAtTs: Date;
  summary: string;
  reviewStatus: string;
  visibility: string;
  structuredData: unknown;
  confidence: string;
  importance: string;
  supersedesId: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
  communicationDetail: {
    direction: string;
    channel: string | null;
    parentType: string | null;
    parentConcerns: unknown;
    teacherResponses: unknown;
    agreements: unknown;
    followUps: unknown;
    nextContactAtTs: Date | null;
    moderationFlagged: boolean | null;
    moderationReasons: unknown;
  } | null;
}

interface AssessmentLike {
  id: string;
  teacherId: string;
  studentRecordId: string;
  examName: string | null;
  subject: string | null;
  examDateTs: Date | null;
  score: number | null;
  fullScore: number | null;
  classRank: number | null;
  gradeRank: number | null;
  percentile: number | null;
  previousScore: number | null;
  note: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

interface LessonLike {
  id: string;
  teacherId: string;
  studentId: string;
  scheduleId: string;
  dateTs: Date;
  status: string;
  progress: string | null;
  studentState: string | null;
  homework: string | null;
  teacherNote: string | null;
  sourceNoteId: string | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

interface FeedbackLike {
  id: string;
  teacherId: string;
  studentId: string;
  lessonId: string | null;
  title: string;
  content: string;
  status: string;
  channel: string | null;
  parentName: string | null;
  sentAtTs: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: unknown;
  createdAtTs: Date;
  updatedAtTs: Date;
}

/**
 * S2 平移：工厂签名从 createStudentTimelineService(prisma) 扩展为
 * createStudentTimelineService(prisma | { getClient })——向后兼容。
 * getClient 请求期解析（数据库路由），未配置时回退装配期 client。
 */
export interface StudentTimelineServiceOptions {
  getClient: () => Promise<StudentTimelinePrismaClient>;
  /** P8 phase-3 批1：字段加密 cipher（缺省 env 构建；未配置 → 明文旧行直通双读）。 */
  cipher?: FieldCipher;
}

function isStudentTimelineServiceOptions(
  value: StudentTimelinePrismaClient | StudentTimelineServiceOptions,
): value is StudentTimelineServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as StudentTimelineServiceOptions).getClient === 'function';
}

export function createStudentTimelineService(
  prismaOrOptions: StudentTimelinePrismaClient | StudentTimelineServiceOptions,
): StudentTimelineService {
  const getClient = isStudentTimelineServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isStudentTimelineServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();

  return {
    async getStudentTimeline(input) {
      const prisma = await getClient();
      const legacyLimit = input.limit;
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? legacyLimit ?? DEFAULT_LIMIT;
      if (legacyLimit !== undefined && (!Number.isSafeInteger(legacyLimit) || legacyLimit < 1 || legacyLimit > MAX_LIMIT)) {
        return err(validationError('limit 必须在 1-200 之间', 'limit'));
      }
      if (!Number.isSafeInteger(page) || page < 1) {
        return err(validationError('page 必须是大于等于 1 的整数', 'page'));
      }
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIMIT) {
        return err(validationError('pageSize 必须在 1-200 之间', 'pageSize'));
      }
      if (input.from && input.to && input.from.getTime() >= input.to.getTime()) {
        return err(validationError('from 必须早于 to', 'from'));
      }
      if ((input.from && Number.isNaN(input.from.getTime())) || (input.to && Number.isNaN(input.to.getTime()))) {
        return err(validationError('时间范围必须是有效时间', 'from'));
      }
      const allowedTypes = new Set<TimelineEntryType>(['record', 'assessment', 'lesson', 'feedback']);
      if (input.types?.some((type) => !allowedTypes.has(type))) {
        return err(validationError('types 包含不合法类型', 'types'));
      }
      if (input.categories?.some((category) => !TIMELINE_CATEGORIES.has(category))) {
        return err(validationError('categories 包含不合法类别', 'categories'));
      }

      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) {
        return err(notFound('学生不存在'));
      }

      const [records, lessons, feedbacks] = await Promise.all([
        prisma.studentRecord.findMany({
          where: {
            teacherId: input.teacherId,
            studentId: input.studentId,
            reviewStatus: { not: 'superseded' },
          },
          include: { assessment: true, communicationDetail: true },
        }),
        prisma.lesson.findMany({
          where: { teacherId: input.teacherId, studentId: input.studentId },
        }),
        prisma.parentFeedback.findMany({
          where: { teacherId: input.teacherId, studentId: input.studentId },
        }),
      ]);

      const entries: TimelineEntry[] = [];
      for (const record of records) {
        entries.push(
          record.assessment ? toAssessmentEntry(record, record.assessment) : toRecordEntry(record, cipher),
        );
      }
      for (const lesson of lessons) {
        entries.push(toLessonEntry(lesson, cipher));
      }
      for (const feedback of feedbacks) {
        entries.push(toFeedbackEntry(feedback, cipher));
      }

      entries.sort((a, b) => {
        const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
        if (byTime !== 0) return byTime;
        const byType = TIMELINE_TYPE_ORDER[a.type] - TIMELINE_TYPE_ORDER[b.type];
        if (byType !== 0) return byType;
        return a.id.localeCompare(b.id);
      });

      const filtered = entries.filter((entry) => {
        if (input.from && entry.occurredAt < input.from) return false;
        if (input.to && entry.occurredAt >= input.to) return false;
        if (input.types && input.types.length > 0 && !input.types.includes(entry.type)) return false;
        if (input.categories && input.categories.length > 0 && !input.categories.includes(entry.category ?? '')) return false;
        return true;
      });
      const total = filtered.length;
      const offset = (page - 1) * pageSize;
      const items = filtered.slice(offset, offset + pageSize);
      return ok({ items, total, page, pageSize, hasMore: offset + items.length < total });
    },

    async getStudentTimelineDetail(input) {
      const prisma = await getClient();
      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) return err(notFound('学生不存在'));
      if (input.entryType === 'record' || input.entryType === 'assessment') {
        const record = await prisma.studentRecord.findFirst({
          where: { id: input.entryId, teacherId: input.teacherId, studentId: input.studentId },
          include: { assessment: true, communicationDetail: true },
        });
        if (!record || (input.entryType === 'assessment') !== Boolean(record.assessment)) {
          return err(notFound('时间线记录不存在'));
        }
        const recordData = toStudentRecordDetail(record, cipher);
        return input.entryType === 'assessment' && record.assessment
          ? ok({ type: 'assessment' as const, record: recordData, assessment: toAssessmentDetail(record.assessment, cipher) })
          : ok({ type: 'record' as const, record: recordData });
      }
      if (input.entryType === 'lesson') {
        const lesson = await prisma.lesson.findFirst({
          where: { id: input.entryId, teacherId: input.teacherId, studentId: input.studentId },
        });
        if (!lesson) return err(notFound('时间线课程不存在'));
        return ok({ type: 'lesson' as const, lesson: toLessonDetail(lesson, cipher) });
      }
      const feedback = await prisma.parentFeedback.findFirst({
        where: { id: input.entryId, teacherId: input.teacherId, studentId: input.studentId },
      });
      if (!feedback) return err(notFound('时间线反馈不存在'));
      return ok({ type: 'feedback' as const, feedback: toFeedbackDetail(feedback, cipher) });
    },
  };
}

function toRecordEntry(record: RecordLike, cipher: FieldCipher | undefined): TimelineEntry {
  return {
    type: 'record',
    id: record.id,
    occurredAt: record.occurredAtTs,
    title: decryptFieldValue(cipher, record.summary),
    summary: decryptFieldValue(cipher, record.summary),
    category: record.category,
    reviewStatus: record.reviewStatus,
    visibility: record.visibility,
    status: null,
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: record.category === 'parent_communication' && record.communicationDetail
      ? serializeCommunicationDetail(record.communicationDetail, cipher)
      : null,
    openTarget: { type: 'record', recordId: record.id, sourceRecordId: record.sourceRecordId },
  };
}

function serializeCommunicationDetail(detail: {
  direction: string;
  channel: string | null;
  parentType: string | null;
  parentConcerns: unknown;
  teacherResponses: unknown;
  agreements: unknown;
  followUps: unknown;
  nextContactAtTs: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: unknown;
}, cipher: FieldCipher | undefined) {
  return {
    direction: detail.direction,
    channel: detail.channel,
    parentType: detail.parentType,
    parentConcerns: decryptJsonFieldValue(cipher, detail.parentConcerns) as string[],
    teacherResponses: decryptJsonFieldValue(cipher, detail.teacherResponses) as string[],
    agreements: decryptJsonFieldValue(cipher, detail.agreements) as string[],
    followUps: decryptJsonFieldValue(cipher, detail.followUps) as string[],
    nextContactAtTs: detail.nextContactAtTs ? detail.nextContactAtTs.toISOString() : null,
    moderationFlagged: detail.moderationFlagged,
    moderationReasons: Array.isArray(detail.moderationReasons)
      ? detail.moderationReasons.filter((reason): reason is string => typeof reason === 'string')
      : null,
  };
}

function toAssessmentEntry(record: RecordLike, assessment: AssessmentLike): TimelineEntry {
  const title = `${assessment.subject ?? ''} ${assessment.examName ?? ''}`.trim();

  const summaryParts: string[] = [];
  if (assessment.examName !== null) summaryParts.push(assessment.examName);
  if (assessment.subject !== null) summaryParts.push(assessment.subject);
  if (assessment.score !== null) summaryParts.push(String(assessment.score));

  return {
    type: 'assessment',
    id: record.id,
    occurredAt: record.occurredAtTs,
    title: title === '' ? '成绩' : title,
    summary: summaryParts.length > 0 ? summaryParts.join(' / ') : null,
    category: record.category,
    reviewStatus: record.reviewStatus,
    visibility: record.visibility,
    status: null,
    score: assessment.score,
    fullScore: assessment.fullScore,
    examName: assessment.examName,
    subject: assessment.subject,
    communicationDetail: null,
    openTarget: { type: 'assessment', recordId: record.id, sourceRecordId: record.sourceRecordId },
  };
}

function toLessonEntry(lesson: LessonLike, cipher: FieldCipher | undefined): TimelineEntry {
  return {
    type: 'lesson',
    id: lesson.id,
    occurredAt: lesson.dateTs,
    title: '课次记录',
    summary: lesson.progress !== null
      ? decryptFieldValue(cipher, lesson.progress)
      : (lesson.teacherNote !== null ? decryptFieldValue(cipher, lesson.teacherNote) : null),
    category: null,
    reviewStatus: null,
    visibility: null,
    status: lesson.status,
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: null,
    openTarget: { type: 'lesson', lessonId: lesson.id },
  };
}

function toFeedbackEntry(feedback: FeedbackLike, cipher: FieldCipher | undefined): TimelineEntry {
  return {
    type: 'feedback',
    id: feedback.id,
    occurredAt: feedback.sentAtTs ?? feedback.createdAtTs,
    title: decryptFieldValue(cipher, feedback.title),
    summary: decryptFieldValue(cipher, feedback.content),
    category: null,
    reviewStatus: null,
    visibility: null,
    status: feedback.status,
    score: null,
    fullScore: null,
    examName: null,
    subject: null,
    communicationDetail: null,
    openTarget: { type: 'feedback', feedbackId: feedback.id },
  };
}

function toStudentRecordDetail(record: RecordLike, cipher: FieldCipher | undefined): StudentTimelineRecordData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    sourceRecordId: record.sourceRecordId,
    category: record.category,
    occurredAt: record.occurredAtTs,
    summary: decryptFieldValue(cipher, record.summary),
    structuredData: decryptJsonFieldValue(cipher, record.structuredData) as Record<string, unknown> | null,
    confidence: record.confidence,
    reviewStatus: record.reviewStatus,
    visibility: record.visibility,
    importance: record.importance,
    supersedesId: record.supersedesId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

function toAssessmentDetail(
  assessment: AssessmentLike,
  cipher: FieldCipher | undefined,
): StudentTimelineAssessmentData {
  return {
    id: assessment.id,
    teacherId: assessment.teacherId,
    studentRecordId: assessment.studentRecordId,
    examName: assessment.examName,
    subject: assessment.subject,
    examDate: assessment.examDateTs,
    score: assessment.score,
    fullScore: assessment.fullScore,
    classRank: assessment.classRank,
    gradeRank: assessment.gradeRank,
    percentile: assessment.percentile,
    previousScore: assessment.previousScore,
    note: assessment.note === null ? null : decryptFieldValue(cipher, assessment.note),
    createdAt: assessment.createdAtTs,
    updatedAt: assessment.updatedAtTs,
  };
}

function toLessonDetail(lesson: LessonLike, cipher: FieldCipher | undefined): StudentTimelineLessonData {
  return {
    id: lesson.id,
    teacherId: lesson.teacherId,
    studentId: lesson.studentId,
    scheduleId: lesson.scheduleId,
    date: lesson.dateTs,
    status: lesson.status,
    progress: lesson.progress === null ? null : decryptFieldValue(cipher, lesson.progress),
    studentState: lesson.studentState === null ? null : decryptFieldValue(cipher, lesson.studentState),
    homework: lesson.homework === null ? null : decryptFieldValue(cipher, lesson.homework),
    teacherNote: lesson.teacherNote === null ? null : decryptFieldValue(cipher, lesson.teacherNote),
    sourceNoteId: lesson.sourceNoteId,
    createdAt: lesson.createdAtTs,
    updatedAt: lesson.updatedAtTs,
  };
}

function toFeedbackDetail(
  feedback: FeedbackLike,
  cipher: FieldCipher | undefined,
): StudentTimelineFeedbackData {
  const status = feedback.status === 'reviewed' || feedback.status === 'sent' || feedback.status === 'archived'
    ? feedback.status
    : 'draft';
  return {
    id: feedback.id,
    teacherId: feedback.teacherId,
    studentId: feedback.studentId,
    lessonId: feedback.lessonId,
    title: decryptFieldValue(cipher, feedback.title),
    content: decryptFieldValue(cipher, feedback.content),
    status,
    channel: feedback.channel,
    parentName: feedback.parentName === null ? null : decryptFieldValue(cipher, feedback.parentName),
    sentAt: feedback.sentAtTs,
    moderationFlagged: feedback.moderationFlagged,
    moderationReasons: Array.isArray(feedback.moderationReasons)
      ? feedback.moderationReasons.filter((reason): reason is string => typeof reason === 'string')
      : null,
    createdAt: feedback.createdAtTs,
    updatedAt: feedback.updatedAtTs,
  };
}
