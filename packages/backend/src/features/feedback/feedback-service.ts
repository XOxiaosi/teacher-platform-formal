import { err, internalError, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { Prisma } from '@prisma/client';
import { createFeedbackWriter } from './create-feedback.js';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  decryptJsonFieldValue,
  encryptFieldValue,
} from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from './rfc3339-instant.js';
import { moderateFeedbackForSend } from './feedback-moderation.js';
import { toFeedbackStatus, toParentFeedbackData } from './feedback-record.js';
import type {
  CreateFeedbackServiceOptions,
  EvidenceType,
  FeedbackEvidenceSnapshotInput,
  FeedbackService,
  FeedbackSnapshotData,
  FeedbackStatus,
} from './types.js';

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
  // S1 明文边界：只有内置 local adapter 可接收解密后的 title/content。
  const moderation = options.moderation?.provider === 'local' ? options.moderation : undefined;
  const logger = options.logger;

  async function resolve(): Promise<{ prisma: Prisma.TransactionClient | import('@prisma/client').PrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: options.trustedClock ?? createDatabaseTrustedClock(prisma) };
  }

  return {
    createFeedback: createFeedbackWriter(options),

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
          sourceVersion: rec.sourceVersion ?? undefined,
          originalDeleted: rec.originalDeletedAtSave ?? undefined,
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
