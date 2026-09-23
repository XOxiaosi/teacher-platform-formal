import { Prisma, type PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, versionConflict, type CommonError, type Result } from '@teacher-platform/contracts';
import { createLessonService } from '../../../features/lessons/index.js';
import { createLessonLedgerService } from '../../../features/payments/index.js';
import type { LessonLedgerBalance, LessonLedgerEntryData } from '../../../features/payments/types.js';
import { createChangelogService } from '../../../shared/changelog/index.js';
import { createFieldCipherFromEnv, decryptFieldValue, encryptFieldValue, type FieldCipher } from '../../../shared/field-encryption/index.js';
import { createDatabaseTrustedClock } from '../../../shared/trusted-clock/index.js';
import type { ConfirmedLessonStatusCorrectionData, ConfirmLessonStatusCorrectionInput, CorrectableLessonStatus, LessonBalance, LessonStatusCorrectionConfirmationData, LessonStatusFixUseCase, PlannedLessonLedgerEntry, PreparedLessonStatusCorrectionData, PrepareLessonStatusCorrectionInput } from './types.js';

type Db = PrismaClient | Prisma.TransactionClient;
class Rollback<T> extends Error { constructor(readonly result: Result<T, CommonError>) { super('lesson-status-fix rollback'); } }

export interface LessonStatusFixUseCaseOptions { getClient: () => Promise<Db>; cipher?: FieldCipher; }
function isOptions(value: PrismaClient | LessonStatusFixUseCaseOptions): value is LessonStatusFixUseCaseOptions {
  return typeof value === 'object' && value !== null && typeof (value as LessonStatusFixUseCaseOptions).getClient === 'function';
}
function correctable(value: string): value is CorrectableLessonStatus { return value === 'attended' || value === 'absent'; }
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_REASON_LENGTH = 500;
function toBalance(value: LessonLedgerBalance): LessonBalance { return { purchased: value.purchased, attended: value.attended, adjustments: value.adjustments, remaining: value.remaining }; }
function projectedBalance(before: LessonBalance, to: CorrectableLessonStatus): LessonBalance {
  const attendanceDelta = to === 'attended' ? 1 : -1;
  return { ...before, attended: before.attended + attendanceDelta, remaining: before.remaining - attendanceDelta };
}
function plannedEntry(from: CorrectableLessonStatus, to: CorrectableLessonStatus, priorDelta: number): PlannedLessonLedgerEntry | null {
  if (from === 'absent' && to === 'attended') return { entryType: 'attendance_deduction', lessonDelta: -1 };
  return from === 'attended' && to === 'absent' && priorDelta < 0 ? { entryType: 'attendance_reversal', lessonDelta: 1 } : null;
}
function toEntry(row: any, cipher: FieldCipher | undefined): LessonLedgerEntryData {
  return { id: row.id, teacherId: row.teacherId, studentId: row.studentId, entryType: row.entryType, lessonDelta: row.lessonDelta, amount: row.amount ?? null, reason: row.reasonCiphertext == null ? null : decryptFieldValue(cipher, row.reasonCiphertext), paymentId: row.paymentId ?? null, lessonId: row.lessonId ?? null, adjustmentConfirmationId: row.adjustmentConfirmationId ?? null, statusCorrectionConfirmationId: row.statusCorrectionConfirmationId ?? null, clientRequestId: row.clientRequestId ?? null, createdAt: row.createdAtTs };
}
function toConfirmation(row: any, cipher: FieldCipher | undefined): LessonStatusCorrectionConfirmationData {
  return { id: row.id, teacherId: row.teacherId, lessonId: row.lessonId, studentId: row.studentId, fromStatus: row.fromStatus as CorrectableLessonStatus, toStatus: row.toStatus as CorrectableLessonStatus, reason: decryptFieldValue(cipher, row.reasonCiphertext), clientRequestId: row.clientRequestId, status: row.status as 'pending' | 'confirmed' | 'expired', expectedLessonUpdatedAt: row.expectedLessonUpdatedAtTs, confirmedAt: row.confirmedAtTs ?? null, createdAt: row.createdAtTs, updatedAt: row.updatedAtTs, entry: row.ledgerEntry ? toEntry(row.ledgerEntry, cipher) : null };
}

/** A formal attendance correction can only move through prepare then confirm. */
export function createLessonStatusFixUseCase(prismaOrOptions: PrismaClient | LessonStatusFixUseCaseOptions): LessonStatusFixUseCase {
  const getClient = isOptions(prismaOrOptions) ? prismaOrOptions.getClient : async () => prismaOrOptions;
  const cipher = isOptions(prismaOrOptions) ? (prismaOrOptions.cipher ?? createFieldCipherFromEnv()) : createFieldCipherFromEnv();
  async function transact<T>(work: (tx: Db) => Promise<Result<T, CommonError>>): Promise<Result<T, CommonError>> {
    const prisma = await getClient(); const opens = '$transaction' in prisma && typeof (prisma as PrismaClient).$transaction === 'function';
    const run = async (tx: Db) => { const result = await work(tx); if (!result.ok) throw new Rollback(result); return result; };
    // Per-key advisory locks provide the serialization boundary. Read Committed
    // gives a waiter a fresh snapshot after it acquires that lock, so it can
    // replay the winner instead of surfacing a PostgreSQL serialization error.
    // Cross-key confirmations still rely on the Lesson compare-and-set below.
    try { if (opens) return await (prisma as PrismaClient).$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }); return await run(prisma); }
    catch (caught) {
      if (caught instanceof Rollback) { if (!opens) throw caught; return caught.result; }
      if (!opens) throw caught;
      if (caught instanceof Prisma.PrismaClientKnownRequestError && (caught.code === 'P2002' || caught.code === 'P2034')) return err(versionConflict());
      return err(internalError('课次状态更正保存失败'));
    }
  }
  async function balanceFor(tx: Db, teacherId: string, studentId: string) {
    return createLessonLedgerService({ getClient: async () => tx, cipher }).calculateBalance({ teacherId, studentId });
  }
  async function attendanceDelta(tx: Db, teacherId: string, lessonId: string) {
    const aggregate = await tx.lessonLedgerEntry.aggregate({ where: { teacherId, lessonId, entryType: { in: ['attendance_deduction', 'attendance_reversal'] } }, _sum: { lessonDelta: true } });
    return aggregate._sum.lessonDelta ?? 0;
  }
  async function lock(tx: Db, key: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  return {
    async prepareLessonStatusCorrection(input: PrepareLessonStatusCorrectionInput): Promise<Result<PreparedLessonStatusCorrectionData, CommonError>> {
      if (!input.lessonId?.trim()) return err(validationError('lessonId 必填', 'lessonId'));
      if (!CLIENT_REQUEST_ID_PATTERN.test(input.clientRequestId?.trim() ?? '')) return err(validationError('clientRequestId 格式无效', 'clientRequestId'));
      if (!input.reason?.trim() || input.reason.trim().length > MAX_REASON_LENGTH) return err(validationError('更正原因必填且不能超过 500 个字符', 'reason'));
      if (!correctable(input.targetStatus)) return err(validationError('仅可在已上课与缺席之间更正', 'targetStatus'));
      return transact(async (tx) => {
        await lock(tx, `lesson-status-correction:prepare:${input.teacherId}:${input.clientRequestId.trim()}`);
        const existing = await tx.lessonStatusCorrectionConfirmation.findFirst({ where: { teacherId: input.teacherId, clientRequestId: input.clientRequestId.trim() }, include: { ledgerEntry: true } });
        if (existing) {
          if (existing.lessonId !== input.lessonId || existing.toStatus !== input.targetStatus || decryptFieldValue(cipher, existing.reasonCiphertext) !== input.reason.trim()) return err(versionConflict());
          if (existing.status === 'pending') {
            const current = await tx.lesson.findFirst({ where: { id: existing.lessonId, teacherId: input.teacherId }, select: { status: true, updatedAtTs: true } });
            if (!current || current.status !== existing.fromStatus || current.updatedAtTs.getTime() !== existing.expectedLessonUpdatedAtTs.getTime()) return err(versionConflict());
          }
          const balance = await balanceFor(tx, input.teacherId, existing.studentId); if (!balance.ok) return balance;
          const confirmation = toConfirmation(existing, cipher); const before = toBalance(balance.value);
          if (confirmation.status === 'confirmed') return ok({ confirmation, balanceBefore: before, balanceAfter: before, plannedLedgerEntry: confirmation.entry ? { entryType: confirmation.entry.entryType as PlannedLessonLedgerEntry['entryType'], lessonDelta: confirmation.entry.lessonDelta as -1 | 1 } : null });
          return ok({ confirmation, balanceBefore: before, balanceAfter: projectedBalance(before, confirmation.toStatus), plannedLedgerEntry: plannedEntry(confirmation.fromStatus, confirmation.toStatus, await attendanceDelta(tx, input.teacherId, confirmation.lessonId)) });
        }
        const lessons = createLessonService({ getClient: async () => tx });
        const lesson = await lessons.getOwnedLesson({ teacherId: input.teacherId, lessonId: input.lessonId }); if (!lesson.ok) return lesson;
        const schedule = await tx.schedule.findFirst({ where: { id: lesson.value.scheduleId, teacherId: input.teacherId }, select: { status: true } });
        if (!schedule || schedule.status !== 'completed') return err(validationError('仅已完成课程可以更正出勤', 'lessonId'));
        if (!correctable(lesson.value.status)) return err(validationError('仅已生成且已上课或缺席的课次可更正', 'lessonId'));
        if (lesson.value.status === input.targetStatus) return err(validationError('更正前后状态不能相同', 'targetStatus'));
        const now = await createDatabaseTrustedClock(tx).now(); if (!now.ok) return now;
        const created = await tx.lessonStatusCorrectionConfirmation.create({ data: { teacherId: input.teacherId, lessonId: lesson.value.id, studentId: lesson.value.studentId, fromStatus: lesson.value.status, toStatus: input.targetStatus, reasonCiphertext: encryptFieldValue(cipher, input.reason.trim()), clientRequestId: input.clientRequestId.trim(), expectedLessonUpdatedAtTs: lesson.value.updatedAt, createdAtTs: now.value, updatedAtTs: now.value }, include: { ledgerEntry: true } });
        const audit = await createChangelogService(tx, cipher).recordChange({ teacherId: input.teacherId, module: 'lessons', action: 'create', targetType: 'LessonStatusCorrectionConfirmation', targetId: created.id, before: null, after: { lessonId: created.lessonId, studentId: created.studentId, fromStatus: created.fromStatus, toStatus: created.toStatus, status: 'pending' }, source: 'manual' });
        if (!audit.ok) return err(internalError('课次更正审计写入失败'));
        const balance = await balanceFor(tx, input.teacherId, lesson.value.studentId); if (!balance.ok) return balance;
        const before = toBalance(balance.value);
        return ok({ confirmation: toConfirmation(created, cipher), balanceBefore: before, balanceAfter: projectedBalance(before, input.targetStatus), plannedLedgerEntry: plannedEntry(lesson.value.status as CorrectableLessonStatus, input.targetStatus, await attendanceDelta(tx, input.teacherId, lesson.value.id)) });
      });
    },

    async confirmLessonStatusCorrection(input: ConfirmLessonStatusCorrectionInput): Promise<Result<ConfirmedLessonStatusCorrectionData, CommonError>> {
      if (!input.confirmationId?.trim()) return err(validationError('confirmationId 必填', 'confirmationId'));
      return transact(async (tx) => {
        await lock(tx, `lesson-status-correction:confirm:${input.teacherId}:${input.confirmationId.trim()}`);
        const confirmation = await tx.lessonStatusCorrectionConfirmation.findFirst({ where: { id: input.confirmationId.trim(), teacherId: input.teacherId }, include: { ledgerEntry: true } });
        if (!confirmation) return err(notFound('课次状态更正确认不存在'));
        const lessons = createLessonService({ getClient: async () => tx });
        if (confirmation.status === 'confirmed') {
          const lesson = await lessons.getOwnedLesson({ teacherId: input.teacherId, lessonId: confirmation.lessonId }); if (!lesson.ok) return lesson;
          const balance = await balanceFor(tx, input.teacherId, confirmation.studentId); return balance.ok ? ok({ confirmation: toConfirmation(confirmation, cipher), lesson: lesson.value, balance: toBalance(balance.value) }) : balance;
        }
        if (confirmation.status !== 'pending' || !correctable(confirmation.fromStatus) || !correctable(confirmation.toStatus)) return err(validationError('该课次更正不能确认', 'confirmationId'));
        const lessonRow = await tx.lesson.findFirst({ where: { id: confirmation.lessonId, teacherId: input.teacherId }, select: { schedule: { select: { status: true } } } });
        if (!lessonRow || lessonRow.schedule.status !== 'completed') return err(validationError('仅已完成课程可以更正出勤', 'confirmationId'));
        const now = await createDatabaseTrustedClock(tx).now(); if (!now.ok) return now;
        const changed = await tx.lesson.updateMany({ where: { id: confirmation.lessonId, teacherId: input.teacherId, status: confirmation.fromStatus, updatedAtTs: confirmation.expectedLessonUpdatedAtTs }, data: { status: confirmation.toStatus, updatedAtTs: now.value } });
        if (changed.count !== 1) return err(versionConflict());
        const ledger = createLessonLedgerService({ getClient: async () => tx, cipher });
        const entry = await ledger.recordLessonStatusTransition({ teacherId: input.teacherId, lessonId: confirmation.lessonId, fromStatus: confirmation.fromStatus as CorrectableLessonStatus, toStatus: confirmation.toStatus as CorrectableLessonStatus, reason: decryptFieldValue(cipher, confirmation.reasonCiphertext), statusCorrectionConfirmationId: confirmation.id });
        if (!entry.ok) return entry;
        const confirmed = await tx.lessonStatusCorrectionConfirmation.updateMany({ where: { id: confirmation.id, teacherId: input.teacherId, status: 'pending' }, data: { status: 'confirmed', confirmedAtTs: now.value, updatedAtTs: now.value } });
        if (confirmed.count !== 1) return err(versionConflict());
        const lessonAudit = await createChangelogService(tx, cipher).recordChange({ teacherId: input.teacherId, module: 'lessons', action: 'update', targetType: 'Lesson', targetId: confirmation.lessonId, before: { status: confirmation.fromStatus }, after: { status: confirmation.toStatus, correctionConfirmationId: confirmation.id }, source: 'manual' });
        if (!lessonAudit.ok) return err(internalError('课次更正审计写入失败'));
        const confirmationAudit = await createChangelogService(tx, cipher).recordChange({ teacherId: input.teacherId, module: 'lessons', action: 'update', targetType: 'LessonStatusCorrectionConfirmation', targetId: confirmation.id, before: { status: 'pending' }, after: { status: 'confirmed', ledgerEntryId: entry.value?.id ?? null }, source: 'manual' });
        if (!confirmationAudit.ok) return err(internalError('课次更正确认审计写入失败'));
        const lesson = await lessons.getOwnedLesson({ teacherId: input.teacherId, lessonId: confirmation.lessonId }); if (!lesson.ok) return lesson;
        const saved = await tx.lessonStatusCorrectionConfirmation.findFirst({ where: { id: confirmation.id, teacherId: input.teacherId }, include: { ledgerEntry: true } });
        if (!saved) return err(internalError('课次更正确认读取失败'));
        const balance = await balanceFor(tx, input.teacherId, confirmation.studentId); return balance.ok ? ok({ confirmation: toConfirmation(saved, cipher), lesson: lesson.value, balance: toBalance(balance.value) }) : balance;
      });
    },
  };
}
