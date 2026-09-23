import { Prisma, type PrismaClient } from '@prisma/client';
import { ok, err, internalError, notFound, validationError, type CommonError } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import {
  createFieldCipherFromEnv,
  decryptFieldValue,
  encryptFieldValue,
  FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import type {
  CreatePaymentInput,
  ListPaymentsInput,
  PaymentData,
  PaymentService,
  SumLessonCountInput,
  UpdatePaymentInput,
} from './types.js';
import { createLessonLedgerService } from './lesson-ledger-service.js';
import { matchesPaymentCreatePayload } from './payment-idempotency.js';

class PaymentLedgerRollback extends Error {
  constructor(readonly result: { ok: false; error: CommonError }) {
    super('payment ledger transaction rollback');
  }
}

export interface PaymentServiceOptions {
  getClient: () => Promise<PrismaClient>;
  /** P8 phase-3 批6：字段加密 cipher（缺省 env 构建；未配置 → 惰性 SAFETY_BLOCK）。 */
  cipher?: FieldCipher;
}

function isPaymentServiceOptions(
  value: PrismaClient | PaymentServiceOptions,
): value is PaymentServiceOptions {
  return typeof value === 'object'
    && value !== null
    && typeof (value as PaymentServiceOptions).getClient === 'function';
}

export function createPaymentService(
  prismaOrOptions: PrismaClient | PaymentServiceOptions,
): PaymentService {
  const getClient = isPaymentServiceOptions(prismaOrOptions)
    ? prismaOrOptions.getClient
    : async () => prismaOrOptions;
  const cipher = isPaymentServiceOptions(prismaOrOptions)
    ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv())
    : createFieldCipherFromEnv();

  async function resolve(): Promise<{ prisma: PrismaClient; trustedClock: ReturnType<typeof createDatabaseTrustedClock> }> {
    const prisma = await getClient();
    return { prisma, trustedClock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async createPayment(input: CreatePaymentInput) {
      const { prisma, trustedClock } = await resolve();
      if (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim()) {
        return err(validationError('clientRequestId 必填', 'clientRequestId'));
      }
      const clientRequestId = input.clientRequestId.trim();
      const validation = validatePaymentFields(input.amount, input.lessonCount);
      if (!validation.ok) return validation;
      if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) {
        return err(validationError('缴费日期不合法', 'paidAt'));
      }

      const student = await prisma.student.findFirst({
        where: { id: input.studentId, teacherId: input.teacherId },
        select: { id: true },
      });
      if (!student) return err(notFound('学生不存在'));

      const replay = await findMatchingReplay(prisma, input, clientRequestId, cipher);
      if (replay) return replay;

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      const create = async (tx: Prisma.TransactionClient) => {
        const payment = await tx.payment.create({
          data: {
            teacherId: input.teacherId,
            clientRequestId,
            studentId: input.studentId,
            amount: input.amount,
            lessonCount: input.lessonCount,
            paidAtTs: input.paidAt,
            note: input.note === undefined || input.note === null
              ? null
              : encryptFieldValue(cipher, input.note),
            createdAtTs: now.value,
            updatedAtTs: now.value,
          },
        });
        const ledger = await createLessonLedgerService({ getClient: async () => tx, cipher }).recordPurchase({
          teacherId: input.teacherId, studentId: input.studentId, paymentId: payment.id,
          lessonCount: input.lessonCount, amount: input.amount,
        });
        if (!ledger.ok) throw new PaymentLedgerRollback(ledger);
        return payment;
      };
      try {
        const payment = '$transaction' in prisma && typeof (prisma as PrismaClient).$transaction === 'function'
          ? await (prisma as PrismaClient).$transaction(create)
          : await create(prisma as unknown as Prisma.TransactionClient);
        return ok(toPaymentData(payment, cipher));
      } catch (e) {
        if (e instanceof PaymentLedgerRollback) return e.result;
        if (e instanceof Error && e.message === FIELD_ENCRYPTION_MISSING_KEY_WRITE_MESSAGE) {
          return err(internalError(e.message));
        }
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const replay = await findMatchingReplay(prisma, input, clientRequestId, cipher);
          if (replay) return replay;
        }
        return err(internalError('创建缴费记录失败'));
      }
    },

    async getPayment(paymentId: string) {
      const { prisma } = await resolve();
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return err(notFound('缴费记录不存在'));
      try {
        return ok(toPaymentData(payment, cipher));
      } catch (e) {
        return err(internalError(`查询缴费记录失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async getOwnedPayment(input) {
      const { prisma } = await resolve();
      const payment = await prisma.payment.findFirst({
        where: { id: input.paymentId, teacherId: input.teacherId },
      });
      if (!payment) return err(notFound('缴费记录不存在'));
      try {
        return ok(toPaymentData(payment, cipher));
      } catch (e) {
        return err(internalError(`查询缴费记录失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async listPayments(input: ListPaymentsInput) {
      const { prisma } = await resolve();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 20;
      if (page < 1) return err(validationError('页码必须大于等于 1', 'page'));
      if (pageSize < 1) return err(validationError('每页数量必须大于等于 1', 'pageSize'));
      if (input.paidAtFrom && input.paidAtTo && input.paidAtFrom > input.paidAtTo) {
        return err(validationError('开始日期不能晚于结束日期', 'paidAtFrom'));
      }
      const skip = (page - 1) * pageSize;
      const where = buildPaymentWhere(input);

      const [items, total] = await Promise.all([
        prisma.payment.findMany({ where, orderBy: { paidAtTs: 'desc' }, skip, take: pageSize }),
        prisma.payment.count({ where }),
      ]);
      try {
        return ok({ items: items.map((item) => toPaymentData(item, cipher)), total });
      } catch (e) {
        return err(internalError(`查询缴费记录列表失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async updatePayment(input: UpdatePaymentInput) {
      const { prisma, trustedClock } = await resolve();
      const existing = await prisma.payment.findUnique({ where: { id: input.paymentId } });
      if (!existing) return err(notFound('缴费记录不存在'));

      const amount = input.amount ?? existing.amount;
      const lessonCount = input.lessonCount ?? existing.lessonCount;
      const validation = validatePaymentFields(amount, lessonCount);
      if (!validation.ok) return validation;

      const now = await trustedClock.now();
      if (!now.ok) return now;
      if (!(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return err(internalError('TrustedClock返回无效时间'));
      }

      try {
        const updated = await prisma.payment.update({
          where: { id: input.paymentId },
          data: {
            ...(input.amount !== undefined && { amount: input.amount }),
            ...(input.lessonCount !== undefined && { lessonCount: input.lessonCount }),
            ...(input.paidAt !== undefined && { paidAtTs: input.paidAt }),
            ...(input.note !== undefined && {
              note: input.note === null ? null : encryptFieldValue(cipher, input.note),
            }),
            updatedAtTs: now.value,
          },
        });
        return ok(toPaymentData(updated, cipher));
      } catch (e) {
        return err(internalError(`更新缴费记录失败：${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async sumLessonCount(input: SumLessonCountInput) {
      const { prisma } = await resolve();
      const student = await prisma.student.findUnique({ where: { id: input.studentId } });
      if (!student) return err(notFound('学生不存在'));

      const result = await prisma.payment.aggregate({
        where: { studentId: input.studentId },
        _sum: { lessonCount: true },
      });
      return ok(result._sum.lessonCount ?? 0);
    },
  };
}

async function findMatchingReplay(
  prisma: PrismaClient,
  input: CreatePaymentInput,
  clientRequestId: string,
  cipher: FieldCipher | undefined,
) {
  try {
    const existing = await prisma.payment.findFirst({
      where: { teacherId: input.teacherId, clientRequestId },
    });
    if (!existing) return null;
    if (!matchesPaymentCreatePayload(existing, input, cipher)) {
      return err(validationError('clientRequestId 已用于其他缴费内容', 'clientRequestId'));
    }
    const ledger = await prisma.lessonLedgerEntry.findUnique({
      where: { paymentId: existing.id },
      select: {
        teacherId: true,
        studentId: true,
        entryType: true,
        lessonDelta: true,
        amount: true,
        paymentId: true,
      },
    });
    if (
      !ledger
      || ledger.teacherId !== existing.teacherId
      || ledger.studentId !== existing.studentId
      || ledger.entryType !== 'purchase'
      || ledger.lessonDelta !== existing.lessonCount
      || ledger.amount !== existing.amount
      || ledger.paymentId !== existing.id
    ) {
      return err(internalError('缴费重放记录不完整'));
    }
    return ok(toPaymentData(existing, cipher));
  } catch {
    return err(internalError('读取缴费重放记录失败'));
  }
}

function validatePaymentFields(amount: number, lessonCount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return err(validationError('缴费金额必须大于 0', 'amount'));
  if (!Number.isInteger(lessonCount)) return err(validationError('购买课时数必须为整数', 'lessonCount'));
  if (lessonCount <= 0) return err(validationError('购买课时数必须大于 0', 'lessonCount'));
  return ok(true);
}

function buildPaymentWhere(input: ListPaymentsInput) {
  return {
    teacherId: input.teacherId,
    ...(input.studentId && { studentId: input.studentId }),
    ...(input.paidAtFrom || input.paidAtTo ? { paidAtTs: buildPaidAtRange(input) } : {}),
  };
}

function buildPaidAtRange(input: ListPaymentsInput) {
  return {
    ...(input.paidAtFrom && { gte: input.paidAtFrom }),
    ...(input.paidAtTo && { lte: input.paidAtTo }),
  };
}

function toPaymentData(r: any, cipher: FieldCipher | undefined): PaymentData {
  return {
    id: r.id,
    teacherId: r.teacherId,
    studentId: r.studentId,
    amount: r.amount,
    lessonCount: r.lessonCount,
    paidAt: r.paidAtTs,
    note: r.note === null ? null : decryptFieldValue(cipher, r.note),
    createdAt: r.createdAtTs,
    updatedAt: r.updatedAtTs,
  };
}
