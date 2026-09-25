import type { PrismaClient } from '@prisma/client';
import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type { StudentTimelineService, TimelineEntry } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type StudentTimelinePrismaClient = PrismaClient;

interface RecordLike {
  id: string;
  category: string;
  occurredAtTs: Date;
  summary: string;
  reviewStatus: string;
  visibility: string;
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
  examName: string | null;
  subject: string | null;
  score: number | null;
  fullScore: number | null;
}

interface LessonLike {
  id: string;
  dateTs: Date;
  status: string;
  progress: string | null;
  teacherNote: string | null;
}

interface FeedbackLike {
  id: string;
  title: string;
  content: string;
  status: string;
  sentAtTs: Date | null;
  createdAtTs: Date;
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
      const limit = input.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return err(validationError('limit 必须在 1-200 之间', 'limit'));
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
        return a.id.localeCompare(b.id);
      });

      return ok({ items: entries.slice(0, limit), total: entries.length });
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
  };
}
