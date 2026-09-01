import type { Payment, Prisma, PrismaClient } from '@prisma/client';
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
  PaymentChanges,
  PaymentData,
  PaymentEditor,
  UpdatePaymentOwnerInput,
} from './types.js';

const PAYMENT_FIELDS = new Set(['amount', 'lessonCount', 'paidAt', 'note']);

type PaymentEditorPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface CreatePaymentEditorOptions {
  prisma: PaymentEditorPrismaClient;
  trustedClock: TrustedClock;
  /** P8 phase-3 批6：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function hasOwn(changes: PaymentChanges, field: keyof PaymentChanges): boolean {
  return Object.hasOwn(changes, field);
}

function validateStructure(input: UpdatePaymentOwnerInput) {
  if (typeof input.teacherId !== 'string' || input.teacherId.trim() === '') {
    return err(validationError('teacherId 必须是非空字符串', 'teacherId'));
  }
  if (typeof input.paymentId !== 'string' || input.paymentId.trim() === '') {
    return err(validationError('paymentId 必须是非空字符串', 'paymentId'));
  }
  if (
    typeof input.changes !== 'object'
    || input.changes === null
    || Array.isArray(input.changes)
  ) {
    return err(validationError('changes 必须是对象', 'changes'));
  }
  const keys = Object.keys(input.changes);
  if (keys.length === 0) {
    return err(validationError('至少提供一个缴费字段', 'changes'));
  }
  if (keys.some((key) => !PAYMENT_FIELDS.has(key))) {
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

function validateFields(changes: PaymentChanges) {
  if (
    hasOwn(changes, 'amount')
    && (typeof changes.amount !== 'number' || !Number.isFinite(changes.amount) || changes.amount <= 0)
  ) {
    return err(validationError('amount 必须是有限正数', 'amount'));
  }
  if (
    hasOwn(changes, 'lessonCount')
    && (typeof changes.lessonCount !== 'number'
      || !Number.isInteger(changes.lessonCount)
      || changes.lessonCount <= 0)
  ) {
    return err(validationError('lessonCount 必须是正整数', 'lessonCount'));
  }
  if (
    hasOwn(changes, 'paidAt')
    && (!(changes.paidAt instanceof Date) || Number.isNaN(changes.paidAt.getTime()))
  ) {
    return err(validationError('paidAt 无效', 'paidAt'));
  }
  if (hasOwn(changes, 'note') && typeof changes.note !== 'string' && changes.note !== null) {
    return err(validationError('note 必须是字符串或null', 'note'));
  }
  return ok(undefined);
}

function isNoOp(before: Payment, changes: PaymentChanges, cipher: FieldCipher | undefined): boolean {
  return (
    (!hasOwn(changes, 'amount') || changes.amount === before.amount)
    && (!hasOwn(changes, 'lessonCount') || changes.lessonCount === before.lessonCount)
    && (!hasOwn(changes, 'paidAt') || changes.paidAt?.getTime() === before.paidAtTs.getTime())
    && (!hasOwn(changes, 'note') || changes.note === decryptNote(cipher, before.note))
  );
}

function decryptNote(cipher: FieldCipher | undefined, value: string | null): string | null {
  return value === null ? null : decryptFieldValue(cipher, value);
}

function encryptNote(cipher: FieldCipher | undefined, value: string | null): string | null {
  return value === null ? null : encryptFieldValue(cipher, value);
}

function buildUpdateData(
  changes: PaymentChanges,
  updatedAt: Date,
  cipher: FieldCipher | undefined,
): Prisma.PaymentUpdateManyMutationInput {
  const data: Prisma.PaymentUpdateManyMutationInput = { updatedAtTs: updatedAt };
  if (hasOwn(changes, 'amount')) data.amount = changes.amount;
  if (hasOwn(changes, 'lessonCount')) data.lessonCount = changes.lessonCount;
  if (hasOwn(changes, 'paidAt')) {
    data.paidAtTs = changes.paidAt;
  }
  if (hasOwn(changes, 'note')) data.note = encryptNote(cipher, changes.note as string | null);
  return data;
}

function toPaymentData(record: Payment, cipher: FieldCipher | undefined): PaymentData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    amount: record.amount,
    lessonCount: record.lessonCount,
    paidAt: record.paidAtTs,
    note: decryptNote(cipher, record.note),
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

export function createPaymentEditor(options: CreatePaymentEditorOptions): PaymentEditor {
  const { prisma, trustedClock } = options;
  const cipher = options.cipher ?? createFieldCipherFromEnv();

  return {
    async updatePayment(input) {
      const structure = validateStructure(input);
      if (!structure.ok) return structure;

      const before = await prisma.payment.findFirst({
        where: { id: input.paymentId, teacherId: input.teacherId },
      });
      if (!before) return err(notFound('缴费记录不存在'));

      if (
        input.expectedUpdatedAt !== undefined
        && input.expectedUpdatedAt.getTime() !== before.updatedAtTs.getTime()
      ) {
        return err(versionConflict());
      }

      const fields = validateFields(input.changes);
      if (!fields.ok) return fields;
      if (isNoOp(before, input.changes, cipher)) {
        return err(validationError('缴费记录未发生变化', 'changes'));
      }

      const clockResult = await trustedClock.now();
      if (!clockResult.ok) return clockResult;
      const nextToken = clockResult.value;
      if (
        !(nextToken instanceof Date)
        || Number.isNaN(nextToken.getTime())
        || nextToken.getTime() === before.updatedAtTs.getTime()
      ) {
        return err(internalError('数据库可信版本token不可用'));
      }

      try {
        const updated = await prisma.payment.updateMany({
          where: {
            id: input.paymentId,
            teacherId: input.teacherId,
            updatedAtTs: before.updatedAtTs,
          },
          data: buildUpdateData(input.changes, nextToken, cipher),
        });

        if (updated.count === 0) {
          const current = await prisma.payment.findFirst({
            where: { id: input.paymentId, teacherId: input.teacherId },
            select: { id: true },
          });
          return current ? err(versionConflict()) : err(notFound('缴费记录不存在'));
        }

        const after = await prisma.payment.findFirst({
          where: { id: input.paymentId, teacherId: input.teacherId },
        });
        if (!after) return err(internalError('缴费记录更新后不可读取'));

        return ok({
          before: toPaymentData(before, cipher),
          after: toPaymentData(after, cipher),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return err(internalError(`更新缴费记录失败：${message}`));
      }
    },
  };
}
