import { err, internalError, notFound, ok } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
} from '../../../shared/field-encryption/index.js';
import type {
  AssembleParentFeedbackContextResult,
  AssembleParentFeedbackContextUseCase,
  CreateAssembleParentFeedbackContextUseCaseOptions,
  FeedbackEvidenceItem,
  FeedbackEvidenceType,
} from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90;
const MAX_ASSESSMENTS = 3;
const MAX_OTHER_RECORDS = 20;
const MAX_LESSONS = 6;
const OTHER_RECORDS_QUERY_TAKE = 50;

export function createAssembleParentFeedbackContextUseCase(
  options: CreateAssembleParentFeedbackContextUseCaseOptions,
): AssembleParentFeedbackContextUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批1/2：解密用 cipher（缺省 env 构建——明文旧行双读直通）
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async execute(input) {
      const prisma = await getClient();
      const { teacherId, studentId } = input;

      // 1. Owner check
      const student = await prisma.student.findFirst({
        where: { id: studentId, teacherId },
        select: { id: true },
      });
      if (!student) {
        return err(notFound('学生不存在'));
      }

      // 2. Trusted clock
      const clockResult = await createDatabaseTrustedClock(prisma).now();
      if (!clockResult.ok) return clockResult;
      const now = clockResult.value;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return err(internalError('数据库可信时间不可用'));
      }
      const windowEnd = now;

      // 3. Determine window start
      const lastFeedback = await prisma.parentFeedback.findFirst({
        where: {
          teacherId,
          studentId,
          status: { in: ['sent', 'reviewed'] },
        },
        orderBy: { sentAtTs: 'desc' },
        select: { sentAtTs: true, updatedAtTs: true },
      });
      const lastFeedbackAt: Date | undefined = lastFeedback?.sentAtTs ?? lastFeedback?.updatedAtTs ?? undefined;

      const defaultStart = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);
      const maxLookback = new Date(now.getTime() - MAX_LOOKBACK_DAYS * MS_PER_DAY);

      let windowStart: Date;
      if (lastFeedbackAt) {
        windowStart = lastFeedbackAt > maxLookback ? lastFeedbackAt : maxLookback;
      } else {
        windowStart = defaultStart;
      }

      // 4. Assessments (category='assessment')
      // 门槛：reviewStatus=confirmed + visibility=parent_shareable + owner 匹配。
      // 不按 supersedesId 过滤：被取代的旧记录 reviewStatus 已是 'superseded' 会被 confirmed 挡掉；
      // 而改正后的当前记录 supersedesId 指向旧记录（非 null），若过滤会漏掉它。
      const assessmentRecords = await prisma.studentRecord.findMany({
        where: {
          teacherId,
          studentId,
          reviewStatus: 'confirmed',
          visibility: 'parent_shareable',
          category: 'assessment',
          occurredAtTs: { gte: windowStart },
        },
        orderBy: { occurredAtTs: 'desc' },
        take: MAX_ASSESSMENTS,
      });

      const assessmentRecordIds = assessmentRecords.map((r) => r.id);
      const assessmentDetails = assessmentRecordIds.length > 0
        ? await prisma.assessmentDetail.findMany({
            where: { teacherId, studentRecordId: { in: assessmentRecordIds } },
          })
        : [];
      const detailByRecordId = new Map(
        assessmentDetails.map((d) => [d.studentRecordId, d]),
      );

      // 5. Other records (category != 'assessment'), query 90 days then filter in JS
      const ninetyDaysAgo = new Date(now.getTime() - MAX_LOOKBACK_DAYS * MS_PER_DAY);
      const otherRecordsRaw = await prisma.studentRecord.findMany({
        where: {
          teacherId,
          studentId,
          reviewStatus: 'confirmed',
          visibility: 'parent_shareable',
          category: { not: 'assessment' },
          occurredAtTs: { gte: ninetyDaysAgo },
        },
        orderBy: { occurredAtTs: 'desc' },
        take: OTHER_RECORDS_QUERY_TAKE,
        include: { communicationDetail: true },
      });

      const filteredOther = otherRecordsRaw.filter((record) => {
        const inWindow = record.occurredAtTs >= windowStart;
        const isImportant = record.importance === 'important' || record.importance === 'critical';
        return inWindow || isImportant;
      });
      const otherRecords = filteredOther.slice(0, MAX_OTHER_RECORDS);

      // 6. Lessons (最近6次或30天)
      const thirtyDaysAgo = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);
      const lessons = await prisma.lesson.findMany({
        where: {
          teacherId,
          studentId,
          dateTs: { gte: thirtyDaysAgo },
        },
        orderBy: { dateTs: 'desc' },
        take: MAX_LESSONS,
      });

      // 7. Merge into evidence
      const evidence: FeedbackEvidenceItem[] = [];

      for (const record of assessmentRecords) {
        const detail = detailByRecordId.get(record.id);
        evidence.push({
          id: record.id,
          type: 'assessment' as FeedbackEvidenceType,
          occurredAt: record.occurredAtTs.toISOString(),
          category: record.category,
          summary: record.summary === null ? null : decryptFieldValue(cipher, record.summary),
          examName: detail?.examName ?? null,
          subject: detail?.subject ?? null,
          score: detail?.score ?? null,
          fullScore: detail?.fullScore ?? null,
          previousScore: detail?.previousScore ?? null,
        });
      }

      for (const record of otherRecords) {
        const detail = (record as any).communicationDetail;
        const parentConcerns = detail
          ? (decryptJsonFieldValue(cipher, detail.parentConcerns) as string[] | null)
          : null;
        const followUps = detail
          ? (decryptJsonFieldValue(cipher, detail.followUps) as string[] | null)
          : null;
        evidence.push({
          id: record.id,
          type: 'record' as FeedbackEvidenceType,
          occurredAt: record.occurredAtTs.toISOString(),
          category: record.category,
          summary: record.summary === null ? null : decryptFieldValue(cipher, record.summary),
          examName: null,
          subject: null,
          score: null,
          fullScore: null,
          previousScore: null,
          parentConcerns: parentConcerns && parentConcerns.length > 0 ? parentConcerns : null,
          followUps: followUps && followUps.length > 0 ? followUps : null,
        });
      }

      for (const lesson of lessons) {
        const lessonText = lesson.progress ?? lesson.studentState ?? lesson.teacherNote ?? lesson.homework ?? null;
        const summary = lessonText === null ? null : decryptFieldValue(cipher, lessonText);
        evidence.push({
          id: lesson.id,
          type: 'lesson' as FeedbackEvidenceType,
          occurredAt: lesson.dateTs.toISOString(),
          category: null,
          summary,
          examName: null,
          subject: null,
          score: null,
          fullScore: null,
          previousScore: null,
        });
      }

      // Sort by occurredAt desc and dedupe by id
      evidence.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      const seen = new Set<string>();
      const deduped: FeedbackEvidenceItem[] = [];
      for (const item of evidence) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        deduped.push(item);
      }

      const result: AssembleParentFeedbackContextResult = {
        studentId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        evidence: deduped,
      };

      return ok(result);
    },
  };
}
