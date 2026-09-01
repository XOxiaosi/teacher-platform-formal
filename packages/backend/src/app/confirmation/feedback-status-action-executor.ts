import type { Prisma } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
  type CommonError,
  type Result,
} from '@teacher-platform/contracts';
import { createChangelogService } from '../../shared/changelog/index.js';
import { createDatabaseTrustedClock, type TrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import { parseRfc3339Instant } from '../../features/feedback/rfc3339-instant.js';
import { moderateFeedbackForSend } from '../../features/feedback/feedback-moderation.js';
import type { FeedbackStatus } from '../../features/feedback/types.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import type { Logger } from '../../shared/logger/index.js';
import type {
  ConfirmableActionExecutionResult,
  ConfirmableActionExecutor,
  ConfirmableActionExecutorInput,
} from './types.js';

export interface CreateFeedbackStatusActionExecutorOptions {
  /** 确认事务内的 raw TransactionClient（updateMany 不经旧自动 changelog extension，避免双审计）。 */
  tx: Prisma.TransactionClient;
  /** TrustedClock（缺省 createDatabaseTrustedClock(tx)；测试可注入替身）。 */
  trustedClock?: TrustedClock;
  /** 字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
  /** 出站审核（仅 provider=local 生效，与 feedback-service 同语义）。 */
  moderation?: ModerationAdapter;
  /** 审核结构化日志；严禁记录 title/content。 */
  logger?: Logger;
}

interface ParsedFeedbackStatusParameters {
  feedbackId: string;
  status: FeedbackStatus;
  expectedUpdatedAt: Date;
  sentAt: Date | undefined;
}

const ALLOWED_PARAMETER_KEYS = new Set(['feedbackId', 'status', 'sentAt', 'expectedUpdatedAt']);

function invalidParameters(message: string) {
  return err(validationError(message, 'parameters'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived';
}

/** 与 feedback-service.canTransition 同一语义（draft→reviewed/archived, reviewed→sent/archived, sent→archived）。 */
function canTransition(from: FeedbackStatus, to: FeedbackStatus): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'reviewed' || to === 'archived';
  if (from === 'reviewed') return to === 'sent' || to === 'archived';
  if (from === 'sent') return to === 'archived';
  return false;
}

/**
 * 复检 PendingAction 的 target/parameters：
 * - target 固定 ParentFeedback，parameters 仅 {feedbackId, status, sentAt?, expectedUpdatedAt}
 * - feedbackId 必须等于 target.id；status 必须合法；expectedUpdatedAt 必须是 RFC3339
 * - sentAt 若存在必须是严格 RFC3339（仅 sent 可携带在状态流转后复检）
 */
function parseParameters(
  input: ConfirmableActionExecutorInput,
): Result<ParsedFeedbackStatusParameters, CommonError> {
  if (input.target.type !== 'ParentFeedback' || !isPlainObject(input.parameters)) {
    return invalidParameters('待确认操作 target 或 parameters 不合法');
  }
  const keys = Object.keys(input.parameters);
  if (keys.length < 3 || keys.length > 4 || keys.some((key) => !ALLOWED_PARAMETER_KEYS.has(key))) {
    return invalidParameters('待确认操作 parameters 结构不合法');
  }
  const { feedbackId, status, sentAt, expectedUpdatedAt } = input.parameters;
  if (typeof feedbackId !== 'string' || feedbackId === '' || feedbackId !== input.target.id) {
    return invalidParameters('待确认操作 target 与 parameters 不一致');
  }
  if (!isFeedbackStatus(status)) return invalidParameters('反馈目标状态不合法');
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt === '') {
    return invalidParameters('待确认操作 expectedUpdatedAt 缺失');
  }
  const expectedInstant = parseRfc3339Instant(expectedUpdatedAt);
  if (expectedInstant === undefined) {
    return invalidParameters('待确认操作 expectedUpdatedAt 不合法');
  }
  let sentAtInstant: Date | undefined;
  if (sentAt !== undefined) {
    if (typeof sentAt !== 'string') return invalidParameters('待确认操作 sentAt 不合法');
    const parsed = parseRfc3339Instant(sentAt);
    if (parsed === undefined) return invalidParameters('待确认操作 sentAt 不合法');
    sentAtInstant = parsed;
  }
  return ok({ feedbackId, status, expectedUpdatedAt: expectedInstant, sentAt: sentAtInstant });
}

export function createFeedbackStatusActionExecutor(
  options: CreateFeedbackStatusActionExecutorOptions,
): ConfirmableActionExecutor {
  const { tx, moderation, logger } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  const trustedClock = options.trustedClock ?? createDatabaseTrustedClock(tx);
  const changelog = createChangelogService(tx, cipher);

  return {
    async execute(input) {
      const parsed = parseParameters(input);
      if (!parsed.ok) return parsed;
      const { status: targetStatus, expectedUpdatedAt } = parsed.value;

      // 教师归属：只读当前 teacher 的反馈；跨 teacher 与不存在统一 NOT_FOUND，不修改状态。
      const existing = await tx.parentFeedback.findFirst({
        where: { id: input.target.id, teacherId: input.teacherId },
      });
      if (!existing) return err(notFound('家长反馈不存在'));
      if (!isFeedbackStatus(existing.status)) {
        return invalidParameters('反馈当前状态不合法');
      }
      const currentStatus = existing.status;

      // 状态流转复检（与服务层同一语义）。
      if (!canTransition(currentStatus, targetStatus)) {
        return err(validationError('非法状态流转', 'status'));
      }

      // sentAt 规则复检：仅 sent 可携带；sent→sent 首次 sentAt 不可覆盖。
      if (parsed.value.sentAt !== undefined && targetStatus !== 'sent') {
        return err(validationError('仅 sent 状态可提供 sentAt', 'sentAt'));
      }
      if (
        currentStatus === 'sent'
        && existing.sentAtTs !== null
        && parsed.value.sentAt !== undefined
        && parsed.value.sentAt.getTime() !== existing.sentAtTs.getTime()
      ) {
        return err(validationError('首次 sentAt 不可覆盖', 'sentAt'));
      }

      // expectedUpdatedAt CAS 预检：与当前行版本不一致 → 版本冲突，不修改状态。
      if (expectedUpdatedAt.getTime() !== existing.updatedAtTs.getTime()) {
        return err(versionConflict());
      }

      // 发送前 moderation（仅 reviewed→sent，与 feedback-service 同语义；明文仅经 local adapter）。
      const moderationResult = currentStatus === 'reviewed' && targetStatus === 'sent'
        ? await moderateFeedbackForSend({
          moderation,
          logger,
          teacherId: input.teacherId,
          feedbackId: input.target.id,
          title: decryptFieldValue(cipher, existing.title),
          content: decryptFieldValue(cipher, existing.content),
        })
        : undefined;

      const nowResult = await trustedClock.now();
      if (!nowResult.ok) return nowResult;
      const now = nowResult.value;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      let sentAtToWrite: Date | undefined;
      if (targetStatus === 'sent') {
        if (parsed.value.sentAt !== undefined) sentAtToWrite = parsed.value.sentAt;
        else if (existing.sentAtTs === null) sentAtToWrite = now;
      }

      // raw updateMany CAS（where id+teacherId+status+updatedAtTs）：不经旧自动 changelog
      // extension，避免双审计；成功后才写唯一一条显式 agent-confirmed 审计，审计失败由
      // ConfirmationTransactionPort 回滚状态与 claim。
      const updated = await tx.parentFeedback.updateMany({
        where: {
          id: input.target.id,
          teacherId: input.teacherId,
          status: currentStatus,
          updatedAtTs: expectedUpdatedAt,
        },
        data: {
          status: targetStatus,
          ...(sentAtToWrite !== undefined && { sentAtTs: sentAtToWrite }),
          ...(moderationResult !== undefined && {
            moderationFlagged: moderationResult.flagged,
            moderationReasons: moderationResult.reasons as Prisma.InputJsonValue,
          }),
          updatedAtTs: now,
        },
      });
      if (updated.count === 0) {
        const current = await tx.parentFeedback.findFirst({
          where: { id: input.target.id, teacherId: input.teacherId },
          select: { id: true },
        });
        return current ? err(versionConflict()) : err(notFound('家长反馈不存在'));
      }

      const finalSentAt = sentAtToWrite ?? existing.sentAtTs;
      const audit = await changelog.recordChange({
        teacherId: input.teacherId,
        module: 'feedback',
        action: 'update',
        targetType: 'ParentFeedback',
        targetId: input.target.id,
        before: {
          status: currentStatus,
          sentAt: existing.sentAtTs?.toISOString() ?? null,
        },
        after: {
          status: targetStatus,
          sentAt: finalSentAt?.toISOString() ?? null,
        },
        source: 'agent-confirmed',
      });
      if (!audit.ok) return err(internalError('变更记录写入失败'));

      if (moderationResult?.flagged) {
        logger?.info('feedback moderation flag', {
          teacherId: input.teacherId,
          feedbackId: input.target.id,
          reasons: moderationResult.reasons,
        });
      }

      return ok<ConfirmableActionExecutionResult>({
        summary: '家长反馈状态已更新',
        references: [{ type: 'ParentFeedback', id: input.target.id }],
      });
    },
  };
}
