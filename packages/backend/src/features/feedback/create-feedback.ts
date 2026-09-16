import { err, internalError, notFound, validationError, type CommonError } from '@teacher-platform/contracts';
import { Prisma } from '@prisma/client';
import { createChangelogService, requireChangelogWrite, runWithAutomaticChangelogSuppressed } from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, encryptFieldValue, encryptJsonFieldValue } from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from './rfc3339-instant.js';
import { toParentFeedbackData } from './feedback-record.js';
import { validateEvidenceArray } from './feedback-evidence-validation.js';
import { resolveFeedbackEvidence } from './feedback-evidence-resolver.js';
import type { CreateFeedbackServiceOptions, FeedbackService, FeedbackEvidenceSnapshotInput } from './types.js';
import { ok } from '@teacher-platform/contracts';
interface PrismaClientLike {
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}
const ENCRYPTION_SAVE_BLOCK = 'SAFETY_BLOCK: 字段加密校验未通过，拒绝保存家长反馈';
function isEncryptionSafetyBlock(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('SAFETY_BLOCK:');
}
class ParentFeedbackCreateTransactionRollback extends Error {
  constructor(readonly encryptionBlocked = false) {
    super(encryptionBlocked ? ENCRYPTION_SAVE_BLOCK : 'parent-feedback-create transaction rollback');
  }
}
class FeedbackEvidenceAdmissionError extends Error {
  constructor(readonly safeError: CommonError) { super('feedback-evidence-admission'); }
}
export function createFeedbackWriter(options: CreateFeedbackServiceOptions): FeedbackService['createFeedback'] {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const changelogFactory = options.changelogFactory ?? ((client: Prisma.TransactionClient) => createChangelogService(client, cipher));
  async function resolve() {
    const prisma = await getClient();
    return { prisma, trustedClock: options.trustedClock ?? createDatabaseTrustedClock(prisma) };
  }
  return {
    async createFeedback(input: Parameters<FeedbackService['createFeedback']>[0]) {
      const { prisma, trustedClock } = await resolve();
      const opensTransaction =
        '$transaction' in prisma &&
        typeof (prisma as { $transaction?: unknown }).$transaction === 'function';
      if (!input.title || input.title.trim() === '') {
        return err(validationError('title 不能为空', 'title'));
      }
      if (!input.content || input.content.trim() === '') {
        return err(validationError('content 不能为空', 'content'));
      }

      // 校验 evidence（若提供）
      let validatedEvidence: FeedbackEvidenceSnapshotInput[] | undefined;
      if (input.evidence !== undefined) {
        const ev = validateEvidenceArray(input.evidence);
        if (!ev.ok) {
          return err(validationError(ev.message, ev.field));
        }
        validatedEvidence = ev.value;
      }

      // 校验 windowStart / windowEnd（若提供）
      let windowStartDate: Date | null = null;
      let windowEndDate: Date | null = null;
      if (input.windowStart !== undefined) {
        const parsed = parseRfc3339Instant(input.windowStart);
        if (parsed === undefined) {
          return err(validationError('windowStart 必须是带时区的严格 RFC3339 时间', 'windowStart'));
        }
        windowStartDate = parsed;
      }
      if (input.windowEnd !== undefined) {
        const parsed = parseRfc3339Instant(input.windowEnd);
        if (parsed === undefined) {
          return err(validationError('windowEnd 必须是带时区的严格 RFC3339 时间', 'windowEnd'));
        }
        windowEndDate = parsed;
      }

      try {
        const now = await trustedClock.now();
        if (!now.ok) return err(now.error);
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        const student = await prisma.student.findFirst({
          where: { id: input.studentId, teacherId: input.teacherId },
          select: { id: true },
        });
        if (!student) return err(notFound('学生不存在'));

        if (input.lessonId !== undefined) {
          const lesson = await prisma.lesson.findFirst({
            where: {
              id: input.lessonId,
              teacherId: input.teacherId,
              studentId: input.studentId,
            },
            select: { id: true },
          });
          if (!lesson) return err(notFound('课次不存在'));
        }

        const feedbackData = {
          teacherId: input.teacherId,
          studentId: input.studentId,
          lessonId: input.lessonId ?? null,
          title: encryptFieldValue(cipher, input.title),
          content: encryptFieldValue(cipher, input.content),
          status: 'draft' as const,
          channel: input.channel ?? null,
          parentName: input.parentName === undefined || input.parentName === null
            ? null
            : encryptFieldValue(cipher, input.parentName),
          createdAtTs: now.value,
          updatedAtTs: now.value,
        };

        const txFn = async (tx: Prisma.TransactionClient) => {
          if (validatedEvidence !== undefined) {
            const resolved = await resolveFeedbackEvidence({ client: tx, teacherId: input.teacherId, studentId: input.studentId,
              references: validatedEvidence, cipher, lock: true });
            if (!resolved.ok) throw new FeedbackEvidenceAdmissionError(resolved.error);
            validatedEvidence = resolved.value;
          }
          const feedback = await tx.parentFeedback.create({ data: feedbackData });
          await requireChangelogWrite(changelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'feedback',
            action: 'create',
            targetType: 'ParentFeedback',
            targetId: feedback.id,
            before: null,
            after: {
              id: feedback.id,
              teacherId: input.teacherId,
              studentId: input.studentId,
              lessonId: input.lessonId ?? null,
              title: input.title,
              content: input.content,
              status: 'draft',
              channel: input.channel ?? null,
              parentName: input.parentName ?? null,
              sentAtTs: null,
              moderationFlagged: null,
              moderationReasons: null,
              createdAtTs: now.value,
              updatedAtTs: now.value,
            },
            source: 'system',
          }));

          if (validatedEvidence !== undefined) {
            const snapshot = await tx.feedbackContextSnapshot.create({
              data: {
                teacherId: input.teacherId,
                feedbackId: feedback.id,
                windowStartTs: windowStartDate,
                windowEndTs: windowEndDate,
                assembledAtTs: now.value,
              },
            });
            if (validatedEvidence.length > 0) {
              await tx.feedbackEvidence.createMany({
                data: validatedEvidence.map((item, index) => ({
                  teacherId: input.teacherId,
                  snapshotId: snapshot.id,
                  recordId: item.id ?? null,
                  type: item.type,
                  occurredAtTs: parseRfc3339Instant(item.occurredAt) as Date,
                  category: item.category ?? null,
                  summary: item.summary === undefined || item.summary === null
                    ? null
                    : encryptFieldValue(cipher, item.summary),
                  examName: item.examName ?? null,
                  subject: item.subject ?? null,
                  score: item.score ?? null,
                  fullScore: item.fullScore ?? null,
                  previousScore: item.previousScore ?? null,
                  parentConcerns: (item.parentConcerns ?? []).length > 0
                    ? (encryptJsonFieldValue(cipher, item.parentConcerns ?? []) as unknown as Prisma.JsonArray)
                    : [],
                  followUps: (item.followUps ?? []).length > 0
                    ? (encryptJsonFieldValue(cipher, item.followUps ?? []) as unknown as Prisma.JsonArray)
                    : [],
                  sortOrder: index,
                })),
              });
            }
          }
          return feedback;
        };

        const rollbackTxFn = async (tx: Prisma.TransactionClient) => {
          try {
            return await txFn(tx);
          } catch (error) {
            if (error instanceof FeedbackEvidenceAdmissionError) throw error;
            // Never expose the underlying database, audit, or evidence failure.
            throw new ParentFeedbackCreateTransactionRollback(isEncryptionSafetyBlock(error));
          }
        };

        const feedback = await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClientLike).$transaction(rollbackTxFn)
            : rollbackTxFn(prisma as unknown as Prisma.TransactionClient)
        ));

        return ok(toParentFeedbackData(feedback, cipher));
      } catch (e) {
        if (e instanceof FeedbackEvidenceAdmissionError) return err(e.safeError);
        if (e instanceof ParentFeedbackCreateTransactionRollback) {
          // A service-owned root transaction can convert the rollback back to a
          // safe Result. A borrowed transaction must reject so its owner cannot
          // commit partial feedback, audit, snapshot, or evidence writes.
          if (!opensTransaction) throw e;
          return err(internalError(e.encryptionBlocked ? ENCRYPTION_SAVE_BLOCK : '创建家长反馈失败'));
        }
        return err(internalError(isEncryptionSafetyBlock(e) ? ENCRYPTION_SAVE_BLOCK : '创建家长反馈失败'));
      }
    }
  }.createFeedback;
}
