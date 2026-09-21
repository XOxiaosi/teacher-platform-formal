import { err, notFound, ok, validationError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptJsonFieldValue } from '../../../shared/field-encryption/index.js';
import { feedbackRecordInclude, projectFeedbackEvidence, resolveFeedbackEvidence } from '../../../features/feedback/feedback-evidence-resolver.js';
import type { AssembleParentFeedbackContextUseCase, CreateAssembleParentFeedbackContextUseCaseOptions } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createAssembleParentFeedbackContextUseCase(
  options: CreateAssembleParentFeedbackContextUseCaseOptions,
): AssembleParentFeedbackContextUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  return {
    async execute(input) {
      const prisma = await getClient();
      const { teacherId, studentId } = input;
      if (!await prisma.student.findFirst({ where: { id: studentId, teacherId }, select: { id: true } })) return err(notFound('学生不存在'));
      if (input.recordIds !== undefined && (input.recordIds.length === 0 || new Set(input.recordIds).size !== input.recordIds.length)) {
        return err(validationError('recordIds 必须是非空且不重复的正式记录列表', 'recordIds'));
      }
      if (input.recordIds !== undefined && input.lessonIds !== undefined) {
        return err(validationError('recordIds 不能与 lessonIds 同时使用', 'recordIds'));
      }
      const clock = await createDatabaseTrustedClock(prisma).now();
      if (!clock.ok) return clock;
      const windowEnd = clock.value;
      const lastFeedback = await prisma.parentFeedback.findFirst({
        where: { teacherId, studentId, status: { in: ['sent', 'reviewed'] } },
        orderBy: { sentAtTs: 'desc' }, select: { sentAtTs: true, updatedAtTs: true },
      });
      const lastAt = lastFeedback?.sentAtTs ?? lastFeedback?.updatedAtTs;
      const maxLookback = new Date(windowEnd.getTime() - 90 * MS_PER_DAY);
      const windowStart = lastAt ? (lastAt > maxLookback ? lastAt : maxLookback) : new Date(windowEnd.getTime() - 30 * MS_PER_DAY);
      let lessonIds: string[] = [];
      let selectedLessons: Map<string, string | null> | undefined;
      if (input.lessonIds !== undefined) {
        if (!Array.isArray(input.lessonIds) || input.lessonIds.length === 0 || input.lessonIds.some(id => typeof id !== 'string' || !id.trim())
          || new Set(input.lessonIds).size !== input.lessonIds.length) return err(validationError('lessonIds 必须是非空且不重复的课次列表', 'lessonIds'));
        const lessons = await prisma.lesson.findMany({ where: { id: { in: input.lessonIds }, teacherId, studentId }, select: { id: true, scheduleId: true } });
        if (lessons.length !== input.lessonIds.length) return err(notFound('课程记录不存在'));
        lessonIds = input.lessonIds;
        selectedLessons = new Map(lessons.map(lesson => [lesson.id, lesson.scheduleId]));
      }
      // Selected lessons use only explicitly linked formal records, including
      // older records. They never import unrelated records from the date window.
      const candidates = await prisma.studentRecord.findMany({ where: {
        teacherId, studentId, reviewStatus: 'confirmed', visibility: 'parent_shareable',
        ...(input.recordIds ? { id: { in: input.recordIds } } : {}),
        ...(selectedLessons || input.recordIds ? {} : { occurredAtTs: { gte: maxLookback, lte: windowEnd } }),
      }, orderBy: [{ occurredAtTs: 'desc' }, { id: 'asc' }],
      include: feedbackRecordInclude });
      if (input.recordIds && candidates.length !== input.recordIds.length) return err(notFound('正式记录不存在'));
      const selected = input.recordIds ? candidates : selectedLessons ? candidates.filter(record => {
        const data = decryptJsonFieldValue(cipher, record.structuredData) as { lessonId?: string; scheduleId?: string } | null;
        if (!data) return false;
        if (data.lessonId) return selectedLessons.has(data.lessonId)
          && (!data.scheduleId || selectedLessons.get(data.lessonId) === data.scheduleId);
        return !!data.scheduleId && [...selectedLessons.values()].includes(data.scheduleId);
      }) : [
        ...candidates.filter(record => record.category === 'assessment' && record.occurredAtTs >= windowStart).slice(0, 3),
        ...candidates.filter(record => record.category !== 'assessment'
          && (record.occurredAtTs >= windowStart || ['important', 'critical'].includes(record.importance))).slice(0, 20),
      ];
      if (!selectedLessons) {
        const linkedIds = selected.flatMap(record => {
          const data = decryptJsonFieldValue(cipher, record.structuredData) as { lessonId?: string } | null;
          return data?.lessonId ? [data.lessonId] : [];
        });
        const linked = linkedIds.length ? await prisma.lesson.findMany({ where: { id: { in: linkedIds }, teacherId, studentId }, select: { id: true } }) : [];
        lessonIds = linked.map(lesson => lesson.id);
      }
      const resolved = await resolveFeedbackEvidence({ client: prisma, teacherId, studentId, cipher,
        references: selected.map(record => projectFeedbackEvidence(record, cipher)) });
      if (!resolved.ok) return resolved;
      return ok({ studentId, lessonIds, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
        evidence: resolved.value.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)) });
    },
  };
}
