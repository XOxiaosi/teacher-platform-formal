import type { ParentFeedback, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  err,
  internalError,
  notFound,
  ok,
  validationError,
  versionConflict,
} from '@teacher-platform/contracts';
import type { TrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  ParentFeedbackContentChanges,
  ParentFeedbackContentEditor,
  UpdateParentFeedbackContentOwnerInput,
} from './types.js';
import { toParentFeedbackData } from './feedback-record.js';

const CONTENT_FIELDS = new Set(['title', 'content']);
type FeedbackEditorPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreateParentFeedbackContentEditorOptions {
  prisma: FeedbackEditorPrismaClient;
  trustedClock: TrustedClock;
  /** P8 phase-3 批1：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function hasOwn(
  changes: ParentFeedbackContentChanges,
  field: keyof ParentFeedbackContentChanges,
): boolean {
  return Object.hasOwn(changes, field);
}

function validateStructure(input: UpdateParentFeedbackContentOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.feedbackId !== 'string' || input.feedbackId.trim() === '') {
    return err(validationError('feedbackId 必须是非空字符串', 'feedbackId'));
  }
  if (typeof input.changes !== 'object' || input.changes === null || Array.isArray(input.changes)) {
    return err(validationError('changes 必须是对象', 'changes'));
  }
  const keys = Object.keys(input.changes);
  if (keys.length === 0) return err(validationError('至少提供一个反馈内容字段', 'changes'));
  if (keys.some((key) => !CONTENT_FIELDS.has(key))) {
    return err(validationError('changes 包含不允许的字段', 'changes'));
  }
  if (
    input.expectedUpdatedAt !== undefined
    && (!(input.expectedUpdatedAt instanceof Date) || Number.isNaN(input.expectedUpdatedAt.getTime()))
  ) {
    return err(validationError('expectedUpdatedAt 无效', 'expectedUpdatedAt'));
  }
  return ok(undefined);
}

function validateFields(changes: ParentFeedbackContentChanges) {
  if (hasOwn(changes, 'title') && (typeof changes.title !== 'string' || changes.title.trim() === '')) {
    return err(validationError('title 不能为空', 'title'));
  }
  if (hasOwn(changes, 'content') && (typeof changes.content !== 'string' || changes.content.trim() === '')) {
    return err(validationError('content 不能为空', 'content'));
  }
  return ok(undefined);
}

function isNoOp(before: ParentFeedback, changes: ParentFeedbackContentChanges, cipher: FieldCipher | undefined): boolean {
  return (!hasOwn(changes, 'title') || changes.title === decryptFieldValue(cipher, before.title))
    && (!hasOwn(changes, 'content') || changes.content === decryptFieldValue(cipher, before.content));
}

function buildUpdateData(
  changes: ParentFeedbackContentChanges,
  updatedAt: Date,
  cipher: FieldCipher | undefined,
): Prisma.ParentFeedbackUpdateManyMutationInput {
  const data: Prisma.ParentFeedbackUpdateManyMutationInput = { updatedAtTs: updatedAt };
  if (hasOwn(changes, 'title')) data.title = encryptFieldValue(cipher, changes.title as string);
  if (hasOwn(changes, 'content')) data.content = encryptFieldValue(cipher, changes.content as string);
  return data;
}

export function createParentFeedbackContentEditor(
  options: CreateParentFeedbackContentEditorOptions,
): ParentFeedbackContentEditor {
  const { prisma, trustedClock } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  return {
    async updateParentFeedbackContent(input) {
      const structure = validateStructure(input);
      if (!structure.ok) return structure;

      const before = await prisma.parentFeedback.findFirst({
        where: { id: input.feedbackId, teacherId: input.teacherId },
      });
      if (!before) return err(notFound('家长反馈不存在'));
      if (
        input.expectedUpdatedAt !== undefined
        && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
      ) return err(versionConflict());
      if (before.status === 'sent' || before.status === 'archived') {
        return err(validationError('已发送或归档的家长反馈不可编辑内容', 'status'));
      }

      const fields = validateFields(input.changes);
      if (!fields.ok) return fields;
      if (isNoOp(before, input.changes, cipher)) {
        return err(validationError('家长反馈内容未发生变化', 'changes'));
      }

      const clockResult = await trustedClock.now();
      if (!clockResult.ok) return clockResult;
      const nextToken = clockResult.value;
      if (
        !(nextToken instanceof Date)
        || Number.isNaN(nextToken.getTime())
        || nextToken.getTime() === before.updatedAtTs.getTime()
      ) return err(internalError('数据库可信版本token不可用'));

      const updated = await prisma.parentFeedback.updateMany({
        where: {
          id: input.feedbackId,
          teacherId: input.teacherId,
          status: before.status,
          updatedAtTs: before.updatedAtTs,
        },
        data: buildUpdateData(input.changes, nextToken, cipher),
      });
      if (updated.count === 0) {
        const current = await prisma.parentFeedback.findFirst({
          where: { id: input.feedbackId, teacherId: input.teacherId },
          select: { id: true },
        });
        return current ? err(versionConflict()) : err(notFound('家长反馈不存在'));
      }

      const after = await prisma.parentFeedback.findFirst({
        where: { id: input.feedbackId, teacherId: input.teacherId },
      });
      if (!after) return err(internalError('家长反馈更新后不可读取'));
      return ok({ before: toParentFeedbackData(before, cipher), after: toParentFeedbackData(after, cipher) });
    },
  };
}
