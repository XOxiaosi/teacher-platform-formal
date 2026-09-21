import { Prisma, type PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptFieldValue, encryptFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { createChangelogService } from '../../shared/changelog/index.js';
import type {
  ConfirmLedgerAdjustmentInput,
  CreateLedgerAdjustmentInput,
  LedgerAdjustmentConfirmationData,
  LessonLedgerBalance,
  LessonLedgerEntryData,
  LessonLedgerService,
  RecordPurchaseLedgerInput,
  RecordLessonStatusTransitionInput,
} from './types.js';

type LedgerPrismaClient = PrismaClient | Prisma.TransactionClient;

export interface LessonLedgerServiceOptions {
  getClient: () => Promise<LedgerPrismaClient>;
  cipher?: FieldCipher;
}

function isOptions(value: LedgerPrismaClient | LessonLedgerServiceOptions): value is LessonLedgerServiceOptions {
  return typeof value === 'object' && value !== null && typeof (value as LessonLedgerServiceOptions).getClient === 'function';
}

export function createLessonLedgerService(
  prismaOrOptions: LedgerPrismaClient | LessonLedgerServiceOptions,
): LessonLedgerService {
  const getClient = isOptions(prismaOrOptions) ? prismaOrOptions.getClient : async () => prismaOrOptions;
  const cipher = isOptions(prismaOrOptions) ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv()) : createFieldCipherFromEnv();

  async function client() {
    const prisma = await getClient();
    return { prisma, clock: createDatabaseTrustedClock(prisma) };
  }

  return {
    async listEntries(input: { teacherId: string; studentId?: string; from?: Date; to?: Date }) {
      const { prisma } = await client();
      const rows = await prisma.lessonLedgerEntry.findMany({
        where: { teacherId: input.teacherId, ...(input.studentId ? { studentId: input.studentId } : {}), ...(input.from || input.to ? { createdAtTs: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) },
        orderBy: { createdAtTs: 'desc' },
      });
      return ok(rows.map((row) => toEntry(row, cipher)));
    },
    async recordPurchase(input: RecordPurchaseLedgerInput) {
      const { prisma, clock } = await client();
      const payment = await prisma.payment.findFirst({
        where: { id: input.paymentId, teacherId: input.teacherId, studentId: input.studentId },
        select: { id: true, lessonCount: true, amount: true },
      });
      if (!payment) return err(notFound('缴费记录不存在'));
      if (payment.lessonCount !== input.lessonCount || payment.amount !== input.amount) return err(versionConflict());
      const now = await clock.now();
      if (!now.ok || !(now.value instanceof Date) || Number.isNaN(now.value?.getTime())) {
        return now.ok ? err(internalError('TrustedClock返回无效时间')) : now;
      }
      try {
        const entry = await prisma.lessonLedgerEntry.create({
          data: { teacherId: input.teacherId, studentId: input.studentId, entryType: 'purchase', lessonDelta: input.lessonCount, amount: input.amount, paymentId: input.paymentId, createdAtTs: now.value },
        });
        const audit = await createChangelogService(prisma, cipher).recordChange({
          teacherId: input.teacherId, module: 'payments', action: 'create', targetType: 'LessonLedgerEntry', targetId: entry.id,
          before: null, after: ledgerAudit(entry), source: 'manual',
        });
        if (!audit.ok) return err(internalError('课时账本审计写入失败'));
        return ok(toEntry(entry, cipher));
      } catch (caught) {
        if (isUnique(caught)) {
          const replay = await prisma.lessonLedgerEntry.findFirst({ where: { paymentId: input.paymentId, teacherId: input.teacherId } });
          if (replay) return ok(toEntry(replay, cipher));
          return err(versionConflict());
        }
        return err(internalError('购课流水写入失败'));
      }
    },

    async recordAttendanceDeduction({ teacherId, lessonId }) {
      const { prisma, clock } = await client();
      const lesson = await prisma.lesson.findFirst({
        where: { id: lessonId, teacherId },
        select: { id: true, studentId: true, status: true },
      });
      if (!lesson) return err(notFound('课次不存在'));
      // 缺席不扣课；其他非出勤状态也不能从这里产生扣课流水。
      if (lesson.status !== 'attended') return ok(null);
      // Schedule completion only needs one initial deduction. Later status
      // corrections use recordLessonStatusTransition and may legitimately add
      // further entries for the same lesson.
      const existing = await prisma.lessonLedgerEntry.findFirst({
        where: { teacherId, lessonId, entryType: 'attendance_deduction' },
        orderBy: { createdAtTs: 'desc' },
      });
      if (existing) return ok(toEntry(existing, cipher));
      const now = await clock.now();
      if (!now.ok || !(now.value instanceof Date) || Number.isNaN(now.value?.getTime())) {
        return now.ok ? err(internalError('TrustedClock返回无效时间')) : now;
      }
      try {
        const entry = await prisma.lessonLedgerEntry.create({
          data: { teacherId, studentId: lesson.studentId, entryType: 'attendance_deduction', lessonDelta: -1, lessonId, createdAtTs: now.value },
        });
        const audit = await createChangelogService(prisma, cipher).recordChange({
          teacherId, module: 'payments', action: 'create', targetType: 'LessonLedgerEntry', targetId: entry.id,
          before: null, after: ledgerAudit(entry), source: 'system',
        });
        if (!audit.ok) return err(internalError('课时账本审计写入失败'));
        return ok(toEntry(entry, cipher));
      } catch (caught) {
        if (isUnique(caught)) {
          const replay = await prisma.lessonLedgerEntry.findFirst({ where: { lessonId, teacherId, entryType: 'attendance_deduction' } });
          if (replay) return ok(toEntry(replay, cipher));
          return err(versionConflict());
        }
        return err(internalError('课时扣减写入失败'));
      }
    },

    async recordLessonStatusTransition(input: RecordLessonStatusTransitionInput) {
      const { prisma, clock } = await client();
      const plan = attendanceTransitionPlan(input);
      if (!plan.ok) return plan;
      // The caller changes status with a compare-and-set in the same
      // transaction. Checking its new state here prevents this helper being
      // used as a free-standing ledger writer.
      const lesson = await prisma.lesson.findFirst({
        where: { id: input.lessonId, teacherId: input.teacherId, status: input.toStatus },
        select: { id: true, studentId: true },
      });
      if (!lesson) return err(notFound('课次不存在'));
      // Older lessons can predate T-017 and are counted by the compatibility
      // projection. They have no deduction entry to reverse, so changing one
      // to absent must not invent a positive ledger balance.
      if (plan.value.entryType === 'attendance_reversal') {
        const priorDelta = await prisma.lessonLedgerEntry.aggregate({
          where: {
            teacherId: input.teacherId,
            lessonId: lesson.id,
            entryType: { in: ['attendance_deduction', 'attendance_reversal'] },
          },
          _sum: { lessonDelta: true },
        });
        if ((priorDelta._sum.lessonDelta ?? 0) >= 0) return ok(null);
      }
      const now = await clock.now();
      if (!now.ok || !(now.value instanceof Date) || Number.isNaN(now.value.getTime())) {
        return now.ok ? err(internalError('TrustedClock返回无效时间')) : now;
      }
      try {
        const entry = await prisma.lessonLedgerEntry.create({
          data: {
            teacherId: input.teacherId,
            studentId: lesson.studentId,
            entryType: plan.value.entryType,
            lessonDelta: plan.value.lessonDelta,
            lessonId: lesson.id,
            reasonCiphertext: encryptFieldValue(cipher, plan.value.reason),
            createdAtTs: now.value,
          },
        });
        const audit = await createChangelogService(prisma, cipher).recordChange({
          teacherId: input.teacherId, module: 'payments', action: 'create', targetType: 'LessonLedgerEntry', targetId: entry.id,
          before: null, after: ledgerAudit(entry), source: 'system',
        });
        if (!audit.ok) return err(internalError('课时账本审计写入失败'));
        return ok(toEntry(entry, cipher));
      } catch (caught) {
        return err(internalError(`课次状态账本写入失败：${caught instanceof Error ? caught.message : String(caught)}`));
      }
    },

    async prepareAdjustment(input: CreateLedgerAdjustmentInput) {
      const validity = validateAdjustment(input);
      if (!validity.ok) return validity;
      const { prisma, clock } = await client();
      const student = await prisma.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
      if (!student) return err(notFound('学生不存在'));
      const existing = await prisma.lessonLedgerAdjustmentConfirmation.findFirst({
        where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId }, include: { ledgerEntry: true },
      });
      if (existing) {
        const same = existing.studentId === input.studentId && existing.entryType === input.entryType
          && existing.lessonDelta === input.lessonDelta && decryptFieldValue(cipher, existing.reasonCiphertext) === input.reason;
        return same ? ok(toConfirmation(existing, cipher)) : err(versionConflict());
      }
      const now = await clock.now();
      if (!now.ok || !(now.value instanceof Date) || Number.isNaN(now.value?.getTime())) {
        return now.ok ? err(internalError('TrustedClock返回无效时间')) : now;
      }
      try {
        const created = await prisma.lessonLedgerAdjustmentConfirmation.create({
          data: {
            teacherId: input.teacherId, studentId: input.studentId, entryType: input.entryType,
            lessonDelta: input.lessonDelta, reasonCiphertext: encryptFieldValue(cipher, input.reason),
            clientRequestId: input.clientRequestId, createdAtTs: now.value, updatedAtTs: now.value,
          }, include: { ledgerEntry: true },
        });
        const audit = await createChangelogService(prisma, cipher).recordChange({
          teacherId: input.teacherId, module: 'payments', action: 'create', targetType: 'LessonLedgerAdjustmentConfirmation', targetId: created.id,
          before: null, after: { studentId: input.studentId, entryType: input.entryType, lessonDelta: input.lessonDelta, status: 'pending' }, source: 'manual',
        });
        if (!audit.ok) return err(internalError('课时调整审计写入失败'));
        return ok(toConfirmation(created, cipher));
      } catch (caught) {
        if (isUnique(caught)) {
          const replay = await prisma.lessonLedgerAdjustmentConfirmation.findFirst({
            where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId },
            include: { ledgerEntry: true },
          });
          if (replay) {
            const same = replay.studentId === input.studentId
              && replay.entryType === input.entryType
              && replay.lessonDelta === input.lessonDelta
              && decryptFieldValue(cipher, replay.reasonCiphertext) === input.reason;
            return same ? ok(toConfirmation(replay, cipher)) : err(versionConflict());
          }
          return err(versionConflict());
        }
        return err(internalError('课时调整确认创建失败'));
      }
    },

    async confirmAdjustment({ teacherId, confirmationId }: ConfirmLedgerAdjustmentInput) {
      const { prisma } = await client();
      const invoke = async (tx: LedgerPrismaClient) => {
        const confirmation = await tx.lessonLedgerAdjustmentConfirmation.findFirst({
          where: { id: confirmationId, teacherId }, include: { ledgerEntry: true },
        });
        if (!confirmation) return err(notFound('课时调整确认不存在'));
        if (confirmation.status === 'confirmed' && confirmation.ledgerEntry) return ok(toConfirmation(confirmation, cipher));
        if (confirmation.status !== 'pending') return err(validationError('该课时调整不能确认', 'confirmationId'));
        const { clock } = await clientFor(tx);
        const now = await clock.now();
        if (!now.ok || !(now.value instanceof Date) || Number.isNaN(now.value?.getTime())) {
          return now.ok ? err(internalError('TrustedClock返回无效时间')) : now;
        }
        const entry = await tx.lessonLedgerEntry.create({
          data: {
            teacherId, studentId: confirmation.studentId, entryType: confirmation.entryType, lessonDelta: confirmation.lessonDelta,
            reasonCiphertext: confirmation.reasonCiphertext, adjustmentConfirmationId: confirmation.id, createdAtTs: now.value,
          },
        });
        const updated = await tx.lessonLedgerAdjustmentConfirmation.updateMany({
          where: { id: confirmation.id, teacherId, status: 'pending' }, data: { status: 'confirmed', confirmedAtTs: now.value, updatedAtTs: now.value },
        });
        if (updated.count !== 1) return err(versionConflict());
        const audit = await createChangelogService(tx, cipher).recordChange({
          teacherId, module: 'payments', action: 'create', targetType: 'LessonLedgerEntry', targetId: entry.id,
          before: null, after: ledgerAudit(entry), source: 'manual',
        });
        if (!audit.ok) return err(internalError('课时账本审计写入失败'));
        const confirmed = await tx.lessonLedgerAdjustmentConfirmation.findFirst({ where: { id: confirmation.id, teacherId }, include: { ledgerEntry: true } });
        return confirmed ? ok(toConfirmation(confirmed, cipher)) : err(internalError('课时调整确认读取失败'));
      };
      try {
        if ('$transaction' in prisma && typeof (prisma as PrismaClient).$transaction === 'function') {
          return await (prisma as PrismaClient).$transaction(invoke);
        }
        return await invoke(prisma);
      } catch (caught) {
        if (isUnique(caught)) {
          const replay = await prisma.lessonLedgerAdjustmentConfirmation.findFirst({ where: { id: confirmationId, teacherId }, include: { ledgerEntry: true } });
          if (replay?.status === 'confirmed' && replay.ledgerEntry) return ok(toConfirmation(replay, cipher));
          return err(versionConflict());
        }
        return err(internalError('课时调整确认失败'));
      }
    },

    async calculateBalance({ teacherId, studentId }) {
      const { prisma } = await client();
      const student = await prisma.student.findFirst({ where: { id: studentId, teacherId }, select: { id: true } });
      if (!student) return err(notFound('学生不存在'));
      const [entries, legacyPayments, legacyLessons] = await Promise.all([
        prisma.lessonLedgerEntry.findMany({ where: { teacherId, studentId }, select: { entryType: true, lessonDelta: true } }),
        prisma.payment.aggregate({ where: { teacherId, studentId, lessonLedgerEntries: { none: {} } }, _sum: { lessonCount: true } }),
        prisma.lesson.count({ where: { teacherId, studentId, status: 'attended', lessonLedgerEntries: { none: {} } } }),
      ]);
      const legacyPurchased = legacyPayments._sum.lessonCount ?? 0;
      const purchased = legacyPurchased + entries.filter((x) => x.entryType === 'purchase').reduce((sum, x) => sum + x.lessonDelta, 0);
      const attended = legacyLessons - entries
        .filter((x) => x.entryType === 'attendance_deduction' || x.entryType === 'attendance_reversal')
        .reduce((sum, x) => sum + x.lessonDelta, 0);
      const adjustments = entries
        .filter((x) => !['purchase', 'attendance_deduction', 'attendance_reversal'].includes(x.entryType))
        .reduce((sum, x) => sum + x.lessonDelta, 0);
      return ok<LessonLedgerBalance>({ purchased, attended, adjustments, remaining: purchased - attended + adjustments });
    },
  };
}

async function clientFor(prisma: LedgerPrismaClient) {
  return { prisma, clock: createDatabaseTrustedClock(prisma) };
}

function validateAdjustment(input: CreateLedgerAdjustmentInput) {
  if (!input.studentId?.trim()) return err(validationError('studentId 必填', 'studentId'));
  if (!input.clientRequestId?.trim()) return err(validationError('clientRequestId 必填', 'clientRequestId'));
  if (!input.reason?.trim()) return err(validationError('调整原因必填', 'reason'));
  if (!Number.isInteger(input.lessonDelta) || input.lessonDelta === 0) return err(validationError('课时调整必须是非零整数', 'lessonDelta'));
  if (!['refund', 'gift', 'manual_adjustment'].includes(input.entryType)) return err(validationError('不支持的账本类型', 'entryType'));
  if (input.entryType === 'refund' && input.lessonDelta >= 0) return err(validationError('退款课时必须为负数', 'lessonDelta'));
  if (input.entryType === 'gift' && input.lessonDelta <= 0) return err(validationError('赠课课时必须为正数', 'lessonDelta'));
  return ok(true);
}

function isUnique(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function ledgerAudit(entry: { studentId: string; entryType: string; lessonDelta: number; paymentId?: string | null; lessonId?: string | null; adjustmentConfirmationId?: string | null }) {
  return { studentId: entry.studentId, entryType: entry.entryType, lessonDelta: entry.lessonDelta, paymentId: entry.paymentId ?? null, lessonId: entry.lessonId ?? null, adjustmentConfirmationId: entry.adjustmentConfirmationId ?? null };
}

function attendanceTransitionPlan(input: RecordLessonStatusTransitionInput) {
  if (input.fromStatus === 'attended' && input.toStatus === 'absent') {
    return ok({ entryType: 'attendance_reversal' as const, lessonDelta: 1, reason: '课次状态由完成改为缺席，回退 1 课时' });
  }
  if (input.fromStatus === 'absent' && input.toStatus === 'attended') {
    return ok({ entryType: 'attendance_deduction' as const, lessonDelta: -1, reason: '课次状态由缺席改为完成，补扣 1 课时' });
  }
  return err(validationError('课次状态账本只接受完成与缺席之间的更正', 'status'));
}

function toEntry(row: any, cipher: FieldCipher | undefined): LessonLedgerEntryData {
  return { id: row.id, teacherId: row.teacherId, studentId: row.studentId, entryType: row.entryType, lessonDelta: row.lessonDelta, amount: row.amount ?? null, reason: row.reasonCiphertext == null ? null : decryptFieldValue(cipher, row.reasonCiphertext), paymentId: row.paymentId ?? null, lessonId: row.lessonId ?? null, adjustmentConfirmationId: row.adjustmentConfirmationId ?? null, clientRequestId: row.clientRequestId ?? null, createdAt: row.createdAtTs };
}

function toConfirmation(row: any, cipher: FieldCipher | undefined): LedgerAdjustmentConfirmationData {
  return { id: row.id, teacherId: row.teacherId, studentId: row.studentId, entryType: row.entryType, lessonDelta: row.lessonDelta, reason: decryptFieldValue(cipher, row.reasonCiphertext), clientRequestId: row.clientRequestId, status: row.status, confirmedAt: row.confirmedAtTs ?? null, createdAt: row.createdAtTs, updatedAt: row.updatedAtTs, entry: row.ledgerEntry ? toEntry(row.ledgerEntry, cipher) : null };
}
