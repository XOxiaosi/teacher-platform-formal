import { err, internalError, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { Prisma } from '@prisma/client';
import {
  createChangelogService,
  requireChangelogWrite,
  runWithAutomaticChangelogSuppressed,
} from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
  encryptJsonFieldValue,
} from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from './rfc3339-instant.js';
import { moderateFeedbackForSend } from './feedback-moderation.js';
import { toFeedbackStatus, toParentFeedbackData } from './feedback-record.js';
import { validateEvidenceArray } from './feedback-evidence-validation.js';
import type {
  CreateFeedbackServiceOptions,
  EvidenceType,
  FeedbackEvidenceSnapshotInput,
  FeedbackService,
  FeedbackSnapshotData,
  FeedbackStatus,
} from './types.js';

interface PrismaClientLike {
  $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}

/**
 * Fixed, non-sensitive signal used to make a borrowed outer transaction roll
 * back when any create-stage work has already written data.
 */
class ParentFeedbackCreateTransactionRollback extends Error {
  constructor() {
    super('parent-feedback-create transaction rollback');
  }
}

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

function canTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'reviewed' || to === 'archived';
  if (from === 'reviewed') return to === 'sent' || to === 'archived';
  if (from === 'sent') return to === 'archived';
  return false;
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): FeedbackService {
  const getClient = options.getClient ?? (async () => options.prisma);
  // P8 phase-3 批1：字段加密 cipher（DI 优先；缺省 env 构建——未配置 → undefined 惰性 SAFETY_BLOCK）
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const changelogFactory = options.changelogFactory
    ?? ((client: Prisma.TransactionClient) => createChangelogService(client, cipher));
  // S1 明文边界：只有内置 local adapter 可接收解密后的 title/content。
  const moderation = options.moderation?.provider === 'local' ? options.moderation : undefined;
  const logger = options.logger;

  async function resolve(): Promise<{ prisma: Prisma.TransactionClient | import('@prisma/client').PrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: options.trustedClock ?? createDatabaseTrustedClock(prisma) };
  }

  return {
    async createFeedback(input) {
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
          } catch {
            // Never expose the underlying database, audit, or evidence failure.
            throw new ParentFeedbackCreateTransactionRollback();
          }
        };

        const feedback = await runWithAutomaticChangelogSuppressed(() => (
          opensTransaction
            ? (prisma as PrismaClientLike).$transaction(rollbackTxFn)
            : rollbackTxFn(prisma as unknown as Prisma.TransactionClient)
        ));

        return ok(toParentFeedbackData(feedback, cipher));
      } catch (e) {
        if (e instanceof ParentFeedbackCreateTransactionRollback) {
          // A service-owned root transaction can convert the rollback back to a
          // safe Result. A borrowed transaction must reject so its owner cannot
          // commit partial feedback, audit, snapshot, or evidence writes.
          if (!opensTransaction) throw e;
          return err(internalError('创建家长反馈失败'));
        }
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`创建家长反馈失败：${message}`));
      }
    },

    async getFeedback(input) {
      const { prisma } = await resolve();
      try {
        const feedback = await prisma.parentFeedback.findFirst({
          where: { id: input.feedbackId, teacherId: input.teacherId },
        });

        if (!feedback) {
          return err(notFound('家长反馈不存在'));
        }

        return ok(toParentFeedbackData(feedback, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询家长反馈失败：${message}`));
      }
    },

    async listFeedbacks(input) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      const skip = (page - 1) * pageSize;

      try {
        const where = {
          teacherId: input.teacherId,
          ...(input.studentId && { studentId: input.studentId }),
          ...(input.status && { status: input.status }),
        };

        const [items, total] = await Promise.all([
          prisma.parentFeedback.findMany({
            where,
            orderBy: { createdAtTs: 'desc' },
            skip,
            take: pageSize,
          }),
          prisma.parentFeedback.count({ where }),
        ]);

        return ok({ items: items.map((item) => toParentFeedbackData(item, cipher)), total });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询家长反馈列表失败：${message}`));
      }
    },

    async updateFeedbackContent(input) {
      const { prisma, trustedClock } = await resolve();
      if (input.title !== undefined && input.title.trim() === '') {
        return err(validationError('title 不能为空', 'title'));
      }
      if (input.content !== undefined && input.content.trim() === '') {
        return err(validationError('content 不能为空', 'content'));
      }
      if (input.title === undefined && input.content === undefined) {
        return err(validationError('未传任何可更新字段'));
      }

      try {
        const existing = await prisma.parentFeedback.findUnique({
          where: { id: input.feedbackId },
        });

        if (!existing || existing.teacherId !== input.teacherId) {
          return err(notFound('家长反馈不存在'));
        }
        if (existing.status === 'sent' || existing.status === 'archived') {
          return err(validationError('已发送或归档的家长反馈不可编辑内容', 'status'));
        }

        const now = await trustedClock.now();
        if (!now.ok) return err(now.error);
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        const updated = await prisma.parentFeedback.updateMany({
          where: {
            id: input.feedbackId,
            teacherId: input.teacherId,
            status: existing.status,
            updatedAtTs: existing.updatedAtTs,
          },
          data: {
            ...(input.title !== undefined && { title: encryptFieldValue(cipher, input.title) }),
            ...(input.content !== undefined && { content: encryptFieldValue(cipher, input.content) }),
            updatedAtTs: now.value,
          },
        });
        if (updated.count === 0) return err(versionConflict());
        const after = await prisma.parentFeedback.findFirst({
          where: { id: input.feedbackId, teacherId: input.teacherId },
        });
        if (!after) return err(internalError('家长反馈更新后不可读取'));
        return ok(toParentFeedbackData(after, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新家长反馈内容失败：${message}`));
      }
    },

    async updateFeedbackStatus(input) {
      const { prisma, trustedClock } = await resolve();
      if (!isFeedbackStatus(input.status)) {
        return err(validationError('非法状态', 'status'));
      }

      const hasExplicitSentAt = input.sentAt !== undefined;
      if (input.status !== 'sent' && hasExplicitSentAt) {
        return err(validationError('仅 sent 状态可提供 sentAt', 'sentAt'));
      }
      const explicitSentAt = hasExplicitSentAt ? parseRfc3339Instant(input.sentAt) : undefined;
      if (hasExplicitSentAt && explicitSentAt === undefined) {
        return err(validationError('sentAt 必须是带时区的严格 RFC3339 时间', 'sentAt'));
      }

      try {
        const existing = await prisma.parentFeedback.findUnique({
          where: { id: input.feedbackId },
        });

        if (!existing || existing.teacherId !== input.teacherId) {
          return err(notFound('家长反馈不存在'));
        }

        const currentStatus = toFeedbackStatus(existing.status);
        if (!canTransition(currentStatus, input.status)) {
          return err(validationError('非法状态流转', 'status'));
        }

        if (currentStatus === 'sent' && existing.sentAtTs !== null && explicitSentAt !== undefined
          && explicitSentAt.getTime() !== existing.sentAtTs.getTime()) {
          return err(validationError('首次 sentAt 不可覆盖', 'sentAt'));
        }

        const moderationResult = currentStatus === 'reviewed' && input.status === 'sent'
          ? await moderateFeedbackForSend({
            moderation,
            logger,
            teacherId: input.teacherId,
            feedbackId: input.feedbackId,
            title: decryptFieldValue(cipher, existing.title),
            content: decryptFieldValue(cipher, existing.content),
          })
          : undefined;

        const now = await trustedClock.now();
        if (!now.ok) return err(now.error);
        if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
          return err(internalError('TrustedClock返回无效时间'));
        }

        let sentAt = currentStatus === 'sent' && existing.sentAtTs !== null
          ? undefined
          : explicitSentAt;
        if (input.status === 'sent' && !hasExplicitSentAt && existing.sentAtTs === null) {
          sentAt = now.value;
        }

        let after;
        try {
          // 使用 extendedWhereUnique 的单行 update 保留 Prisma changelog extension，
          // 同时以 owner/status/updatedAtTs 实施原子 CAS。
          after = await prisma.parentFeedback.update({
            where: {
              id: input.feedbackId,
              teacherId: input.teacherId,
              status: existing.status,
              updatedAtTs: existing.updatedAtTs,
            },
            data: {
              status: input.status,
              ...(sentAt !== undefined && { sentAtTs: sentAt }),
              ...(moderationResult !== undefined && {
                moderationFlagged: moderationResult.flagged,
                moderationReasons: moderationResult.reasons as Prisma.InputJsonValue,
              }),
              updatedAtTs: now.value,
            },
          });
        } catch (caught) {
          if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2025') {
            const current = await prisma.parentFeedback.findFirst({
              where: { id: input.feedbackId, teacherId: input.teacherId },
              select: { id: true },
            });
            return current ? err(versionConflict()) : err(notFound('家长反馈不存在'));
          }
          throw caught;
        }
        if (moderationResult?.flagged) {
          logger?.info('feedback moderation flag', {
            teacherId: input.teacherId,
            feedbackId: input.feedbackId,
            reasons: moderationResult.reasons,
          });
        }
        return ok(toParentFeedbackData(after, cipher));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新家长反馈状态失败：${message}`));
      }
    },

    async getFeedbackSnapshot(input) {
      const { prisma } = await resolve();
      try {
        const feedback = await prisma.parentFeedback.findFirst({
          where: { id: input.feedbackId, teacherId: input.teacherId },
          select: { id: true },
        });
        if (!feedback) {
          return err(notFound('家长反馈不存在'));
        }

        const snapshot = await prisma.feedbackContextSnapshot.findFirst({
          where: { feedbackId: input.feedbackId, teacherId: input.teacherId },
        });
        if (!snapshot) {
          return err(notFound('该反馈没有依据快照'));
        }

        const evidenceRecords = await prisma.feedbackEvidence.findMany({
          where: { snapshotId: snapshot.id, teacherId: input.teacherId },
          orderBy: { sortOrder: 'asc' },
        });

        const evidence: FeedbackEvidenceSnapshotInput[] = evidenceRecords.map((rec) => ({
          id: rec.recordId ?? undefined,
          type: rec.type as EvidenceType,
          occurredAt: rec.occurredAtTs.toISOString(),
          category: rec.category,
          // P8 phase-3 批5：summary/parentConcerns/followUps 解密（双读：明文旧行直通）
          summary: rec.summary === null ? null : decryptFieldValue(cipher, rec.summary),
          examName: rec.examName,
          subject: rec.subject,
          score: rec.score,
          fullScore: rec.fullScore,
          previousScore: rec.previousScore,
          parentConcerns: (decryptJsonFieldValue(cipher, rec.parentConcerns) as string[] | null) ?? [],
          followUps: (decryptJsonFieldValue(cipher, rec.followUps) as string[] | null) ?? [],
        }));

        const result: FeedbackSnapshotData = {
          feedbackId: snapshot.feedbackId,
          windowStart: snapshot.windowStartTs ? snapshot.windowStartTs.toISOString() : null,
          windowEnd: snapshot.windowEndTs ? snapshot.windowEndTs.toISOString() : null,
          assembledAt: snapshot.assembledAtTs.toISOString(),
          evidence,
        };

        return ok(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`查询反馈依据快照失败：${message}`));
      }
    },
  };
}
