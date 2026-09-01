import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ok, err, notFound, validationError, internalError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import {
  defaultChangelogFactory,
  requireChangelogWrite,
  type ChangelogFactory,
} from '../../shared/changelog/index.js';
import type {
  AssessmentService,
  CreateScoreRecordInput,
  CorrectScoreRecordInput,
  ListByStudentInput,
  GetOwnedDetailInput,
  ScoreRecordData,
  StudentRecordData,
  AssessmentDetailData,
} from './types.js';

type AssessmentPrismaClient = PrismaClient | Prisma.TransactionClient;

function assessmentMutationError(error: unknown, fallbackMessage: string) {
  if (
    error instanceof Error
    && error.message === FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE
  ) {
    return internalError(error.message);
  }
  return internalError(fallbackMessage);
}

// 成绩创建所需的公共字段（create 与 correct 复用）
type ScoreFieldsInput = Pick<
  CreateScoreRecordInput,
  'examName' | 'subject' | 'score' | 'fullScore' | 'previousScore'
>;

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateScoreFields(input: ScoreFieldsInput) {
  const hasExamName = hasText(input.examName);
  const hasSubject = hasText(input.subject);
  const hasScore = typeof input.score === 'number';
  if (!hasExamName && !hasSubject && !hasScore) {
    return err(validationError('至少提供考试名称、科目或分数之一'));
  }
  if (typeof input.score === 'number' && input.score <= 0) {
    return err(validationError('分数必须大于 0', 'score'));
  }
  if (typeof input.fullScore === 'number' && input.fullScore <= 0) {
    return err(validationError('满分必须大于 0', 'fullScore'));
  }
  if (typeof input.previousScore === 'number' && input.previousScore <= 0) {
    return err(validationError('上次成绩必须大于 0', 'previousScore'));
  }
  return ok(true);
}

function buildSummary(input: ScoreFieldsInput): string {
  const parts = [input.subject, input.examName].filter(hasText);
  let summary = parts.join(' ');
  if (typeof input.score === 'number') {
    summary = summary ? `${summary} ${input.score}分` : `${input.score}分`;
  }
  return summary.trim() !== '' ? summary : '成绩记录';
}

async function assertOwnedStudent(
  prisma: AssessmentPrismaClient,
  teacherId: string,
  studentId: string,
) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, teacherId },
    select: { id: true },
  });
  return student ? ok(student) : err(notFound('学生不存在'));
}

async function requireTrustedNow(prisma: AssessmentPrismaClient) {
  const now = await createDatabaseTrustedClock(prisma).now();
  if (!now.ok) return now;
  if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
    return err(internalError('TrustedClock返回无效时间'));
  }
  return ok(now.value);
}

export interface AssessmentServiceOptions {
  getClient: () => Promise<AssessmentPrismaClient>;
  /** P8 phase-3 批2：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
  changelogFactory?: ChangelogFactory;
}

function isAssessmentServiceOptions(
  value: AssessmentPrismaClient | AssessmentServiceOptions,
): value is AssessmentServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AssessmentServiceOptions).getClient === 'function';
}

export function createAssessmentService(
  prismaOrOptions: AssessmentPrismaClient | AssessmentServiceOptions,
): AssessmentService {
  const getClient = isAssessmentServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isAssessmentServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();
  const changelogFactory = isAssessmentServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.changelogFactory ?? defaultChangelogFactory)
    : defaultChangelogFactory;

  return {
    async createScoreRecord(input: CreateScoreRecordInput) {
      const prisma = await getClient();
      const owned = await assertOwnedStudent(prisma, input.teacherId, input.studentId);
      if (!owned.ok) return owned;

      const validation = validateScoreFields(input);
      if (!validation.ok) return validation;

      const now = await requireTrustedNow(prisma);
      if (!now.ok) return now;

      try {
        const created = await (prisma as PrismaClient).$transaction((tx) =>
          createScoreRecordInternal(tx, input, now.value, null, cipher, changelogFactory),
        );

        return ok(created);
      } catch (error) {
        return err(assessmentMutationError(error, '创建成绩记录失败'));
      }
    },

    async correctScoreRecord(input: CorrectScoreRecordInput) {
      const prisma = await getClient();
      const oldRecord = await prisma.studentRecord.findFirst({
        where: { id: input.oldRecordId, teacherId: input.teacherId },
      });
      if (!oldRecord) return err(notFound('成绩记录不存在'));
      if (oldRecord.category !== 'assessment') {
        return err(validationError('只能纠正成绩类记录', 'oldRecordId'));
      }
      if (oldRecord.reviewStatus === 'superseded') {
        return err(validationError('已过期的成绩记录不能再次纠正', 'oldRecordId'));
      }

      const validation = validateScoreFields(input);
      if (!validation.ok) return validation;

      const now = await requireTrustedNow(prisma);
      if (!now.ok) return now;

      try {
        const created = await (prisma as PrismaClient).$transaction(async (tx) => {
          const newRecord = await createScoreRecordInternal(
            tx,
            {
              teacherId: input.teacherId,
              studentId: oldRecord.studentId,
              examName: input.examName,
              subject: input.subject,
              score: input.score,
              fullScore: input.fullScore,
              examDate: input.examDate,
              previousScore: input.previousScore,
              note: input.note,
              occurredAt: input.occurredAt,
              sourceText: input.sourceText,
              summaryOverride: input.summaryOverride,
            },
            now.value,
            input.oldRecordId,
            cipher,
            changelogFactory,
          );

          await tx.studentRecord.update({
            where: { id: input.oldRecordId },
            data: { reviewStatus: 'superseded', updatedAtTs: now.value },
          });
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'update',
            targetType: 'StudentRecord',
            targetId: input.oldRecordId,
            before: { reviewStatus: oldRecord.reviewStatus },
            after: { reviewStatus: 'superseded' },
            source: 'manual',
          }));

          return newRecord;
        });

        return ok(created);
      } catch (error) {
        return err(assessmentMutationError(error, '纠正成绩记录失败'));
      }
    },

    async listByStudent(input: ListByStudentInput) {
      const prisma = await getClient();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));

      const owned = await assertOwnedStudent(prisma, input.teacherId, input.studentId);
      if (!owned.ok) return owned;

      const where = {
        teacherId: input.teacherId,
        studentId: input.studentId,
        category: 'assessment',
      };
      const skip = (page - 1) * pageSize;

      try {
        const [records, total] = await Promise.all([
          prisma.studentRecord.findMany({
            where,
            orderBy: { occurredAtTs: 'desc' },
            skip,
            take: pageSize,
          }),
          prisma.studentRecord.count({ where }),
        ]);

        const items: ScoreRecordData[] = [];
        for (const record of records) {
          const detail = await prisma.assessmentDetail.findFirst({
            where: { studentRecordId: record.id, teacherId: input.teacherId },
          });
          if (!detail) continue;
          items.push({
            record: toStudentRecordData(record, cipher),
            detail: toAssessmentDetailData(detail, cipher),
          });
        }

        return ok({ items, total });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询成绩记录列表失败：${message}`));
      }
    },

    async getOwnedDetail(input: GetOwnedDetailInput) {
      const prisma = await getClient();
      const record = await prisma.studentRecord.findFirst({
        where: { id: input.studentRecordId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!record) return err(notFound('成绩记录不存在'));

      const detail = await prisma.assessmentDetail.findFirst({
        where: { studentRecordId: input.studentRecordId, teacherId: input.teacherId },
      });
      if (!detail) return err(notFound('成绩明细不存在'));

      try {
        return ok(toAssessmentDetailData(detail, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询成绩明细失败：${message}`));
      }
    },
  };
}

async function createScoreRecordInternal(
  prisma: Prisma.TransactionClient,
  input: CreateScoreRecordInput,
  now: Date,
  supersedesId: string | null,
  cipher: FieldCipher | undefined,
  changelogFactory: ChangelogFactory,
): Promise<ScoreRecordData> {
  let sourceId: string | null = null;
  if (hasText(input.sourceText)) {
    const sourceRecord = await prisma.studentSourceRecord.create({
      data: {
        teacherId: input.teacherId,
        studentId: input.studentId,
        sourceType: 'agent_text',
        occurredAtTs: now,
        captureStatus: 'captured',
        rawText: encryptFieldValue(cipher, input.sourceText),
        createdAtTs: now,
        updatedAtTs: now,
      },
    });
    sourceId = sourceRecord.id;
    await requireChangelogWrite(changelogFactory(prisma).recordChange({
      teacherId: input.teacherId,
      module: 'student-source-record',
      action: 'create',
      targetType: 'StudentSourceRecord',
      targetId: sourceId,
      before: null,
      after: { sourceType: 'agent_text', studentId: input.studentId },
      source: 'manual',
    }));
  }

  const summary = input.summaryOverride ?? buildSummary(input);
  const encryptedSummary = encryptFieldValue(cipher, summary);
  const occurredAt = input.examDate ?? input.occurredAt ?? now;

  const record = await prisma.studentRecord.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      sourceRecordId: sourceId,
      category: 'assessment',
      occurredAtTs: occurredAt,
      summary: encryptedSummary,
      structuredData: Prisma.JsonNull,
      confidence: 'medium',
      reviewStatus: 'candidate',
      visibility: 'needs_review',
      importance: 'normal',
      supersedesId,
      createdAtTs: now,
      updatedAtTs: now,
    },
  });

  await requireChangelogWrite(changelogFactory(prisma).recordChange({
    teacherId: input.teacherId,
    module: 'student-records',
    action: 'create',
    targetType: 'StudentRecord',
    targetId: record.id,
    before: null,
    after: { category: 'assessment', summary: encryptedSummary, studentId: input.studentId, supersedesId },
    source: 'manual',
  }));

  const detail = await prisma.assessmentDetail.create({
    data: {
      teacherId: input.teacherId,
      studentRecordId: record.id,
      examName: input.examName ?? null,
      subject: input.subject ?? null,
      score: input.score ?? null,
      fullScore: input.fullScore ?? null,
      previousScore: input.previousScore ?? null,
      examDateTs: input.examDate ?? null,
      note: input.note === undefined || input.note === null ? null : encryptFieldValue(cipher, input.note),
      createdAtTs: now,
      updatedAtTs: now,
    },
  });

  await requireChangelogWrite(changelogFactory(prisma).recordChange({
    teacherId: input.teacherId,
    module: 'assessment',
    action: 'create',
    targetType: 'AssessmentDetail',
    targetId: detail.id,
    before: null,
    after: {
      studentRecordId: record.id,
      examName: input.examName ?? null,
      subject: input.subject ?? null,
      score: input.score ?? null,
    },
    source: 'manual',
  }));

  return {
    record: toStudentRecordData(record, cipher),
    detail: toAssessmentDetailData(detail, cipher),
  };
}

function toStudentRecordData(record: any, cipher: FieldCipher | undefined): StudentRecordData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    sourceRecordId: record.sourceRecordId,
    category: record.category,
    occurredAt: record.occurredAtTs,
    summary: decryptFieldValue(cipher, record.summary),
    structuredData:
      record.structuredData == null ? null : (record.structuredData as Record<string, unknown>),
    confidence: record.confidence,
    reviewStatus: record.reviewStatus,
    visibility: record.visibility,
    importance: record.importance,
    supersedesId: record.supersedesId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

function toAssessmentDetailData(record: any, cipher: FieldCipher | undefined): AssessmentDetailData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentRecordId: record.studentRecordId,
    examName: record.examName,
    subject: record.subject,
    examDate: record.examDateTs,
    score: record.score,
    fullScore: record.fullScore,
    classRank: record.classRank,
    gradeRank: record.gradeRank,
    percentile: record.percentile,
    previousScore: record.previousScore,
    note: record.note === null ? null : decryptFieldValue(cipher, record.note),
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}
