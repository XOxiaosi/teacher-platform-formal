import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { err, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptFieldValue, decryptJsonFieldValue, encryptFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { defaultChangelogFactory, requireChangelogWrite } from '../../shared/changelog/index.js';
import type { CaptureService, CaptureView, ConfirmedCaptureRecordView, CreateCaptureServiceOptions, DeletionReceiptView } from './types.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TASK_TYPE = 'text_verbatim_candidate';
const VERSION = 'text-verbatim-v1';
const DELETION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const DELETION_INTERRUPTED = 'CAPTURE_DELETION_INTERRUPTED';

function validRequestId(value: string) { return REQUEST_ID.test(value); }
function json(value: unknown) { return value as Prisma.InputJsonValue; }
function captureView(row: any, cipher: FieldCipher | undefined): CaptureView {
  return {
    id: row.id, sourceType: 'text', sourceChannel: 'web', rawText: decryptFieldValue(cipher, row.rawText), confirmedRecordId: row.candidate.confirmedRecordId ?? null,
    occurredAt: row.occurredAtTs, createdAt: row.createdAtTs,
    task: { id: row.tasks[0].id, status: row.tasks[0].status, processorVersion: row.tasks[0].processorVersion },
    candidate: { id: row.candidate.id, candidateType: 'verbatim_note', payload: decryptJsonFieldValue(cipher, row.candidate.payload) as { text: string }, reviewStatus: row.candidate.reviewStatus === 'confirmed' ? 'confirmed' : 'pending', confirmedRecordId: row.candidate.confirmedRecordId ?? null, confidence: null },
  };
}
function receiptView(row: any): DeletionReceiptView {
  return { id: row.id, eventId: row.eventId, status: row.status, attemptCount: row.attemptCount, retryable: row.retryable, lastErrorCode: row.lastErrorCode, createdAt: row.createdAtTs, completedAt: row.completedAtTs };
}
async function ownedActive(prisma: PrismaClient, teacherId: string, eventId: string) {
  return prisma.captureEvent.findFirst({ where: { id: eventId, teacherId, redactedAtTs: null, deletionReceipt: null }, include: { tasks: { orderBy: { createdAtTs: 'asc' } }, candidate: true } });
}

export function createCaptureService(options: CreateCaptureServiceOptions): CaptureService {
  const getClient = options.getClient ?? (async () => options.prisma);
  const cipher = options.cipher ?? createFieldCipherFromEnv();
  async function now(prisma: PrismaClient) { return createDatabaseTrustedClock(prisma).now(); }
  async function recoverStaleDeletionClaim(prisma: PrismaClient, receiptId: string, teacherId: string, clock: Date) {
    await prisma.captureDeletionReceipt.updateMany({
      where: {
        id: receiptId,
        teacherId,
        status: 'pending',
        retryable: false,
        claimExpiresAtTs: { lte: clock },
      },
      data: {
        status: 'failed',
        retryable: true,
        lastErrorCode: DELETION_INTERRUPTED,
        claimToken: null,
        claimExpiresAtTs: null,
        updatedAtTs: clock,
      },
    });
  }
  async function readReceiptWithRecovery(prisma: PrismaClient, receiptId: string, teacherId: string) {
    const clock = await now(prisma); if (!clock.ok) return clock;
    await recoverStaleDeletionClaim(prisma, receiptId, teacherId, clock.value);
    const receipt = await prisma.captureDeletionReceipt.findFirst({ where: { id: receiptId, teacherId } });
    return receipt ? ok(receipt) : err(notFound('删除回执不存在'));
  }
  async function executeDeletion(prisma: PrismaClient, receiptId: string, teacherId: string) {
    const clock = await now(prisma); if (!clock.ok) return clock;
    await recoverStaleDeletionClaim(prisma, receiptId, teacherId, clock.value);
    const claimToken = randomUUID();
    const claimExpiresAtTs = new Date(clock.value.getTime() + DELETION_CLAIM_LEASE_MS);
    // retryable=true 是持久化的可抢占标记；租约到期后，重启的服务可恢复中断任务。
    const claimed = await prisma.captureDeletionReceipt.updateMany({
      where: { id: receiptId, teacherId, status: { in: ['pending', 'failed'] }, retryable: true },
      data: {
        status: 'pending',
        retryable: false,
        lastErrorCode: null,
        claimToken,
        claimExpiresAtTs,
        attemptCount: { increment: 1 },
        updatedAtTs: clock.value,
      },
    });
    if (claimed.count !== 1) {
      const current = await prisma.captureDeletionReceipt.findFirst({ where: { id: receiptId, teacherId } });
      return current ? ok(receiptView(current)) : err(notFound('删除回执不存在'));
    }
    try {
      await options.deletionExecutor?.();
      const completedClock = await now(prisma); if (!completedClock.ok) return completedClock;
      const updated = await prisma.$transaction(async (tx) => {
        const receipt = await tx.captureDeletionReceipt.findFirst({ where: { id: receiptId, teacherId, claimToken } });
        if (!receipt) return null;
        const completed = await tx.captureDeletionReceipt.updateMany({
          where: { id: receipt.id, teacherId, status: 'pending', retryable: false, claimToken },
          data: {
            status: 'completed',
            retryable: false,
            lastErrorCode: null,
            claimToken: null,
            claimExpiresAtTs: null,
            completedAtTs: completedClock.value,
            updatedAtTs: completedClock.value,
          },
        });
        if (completed.count !== 1) return null;
        await tx.captureEvent.update({ where: { id: receipt.eventId }, data: { rawText: null, redactedAtTs: completedClock.value } });
        await tx.captureCandidate.updateMany({ where: { eventId: receipt.eventId, teacherId }, data: { payload: Prisma.DbNull, redactedAtTs: completedClock.value, updatedAtTs: completedClock.value } });
        await tx.studentSourceRecord.updateMany({
          where: {
            teacherId,
            sourceEntityType: 'CaptureEvent',
            sourceEntityId: receipt.eventId,
            captureStatus: { not: 'deleted' },
          },
          data: {
            rawText: null,
            captureStatus: 'deleted',
            updatedAtTs: completedClock.value,
          },
        });
        await tx.captureTask.updateMany({ where: { eventId: receipt.eventId, teacherId, status: { in: ['queued', 'running'] } }, data: { status: 'cancelled', retryable: false, completedAtTs: completedClock.value, updatedAtTs: completedClock.value } });
        return tx.captureDeletionReceipt.findUnique({ where: { id: receipt.id } });
      });
      if (updated) return ok(receiptView(updated));
      const current = await prisma.captureDeletionReceipt.findFirst({ where: { id: receiptId, teacherId } });
      return current ? ok(receiptView(current)) : err(notFound('删除回执不存在'));
    } catch {
      const failedClock = await now(prisma); if (!failedClock.ok) return failedClock;
      const failed = await prisma.captureDeletionReceipt.updateMany({
        where: { id: receiptId, teacherId, status: 'pending', claimToken },
        data: {
          status: 'failed',
          retryable: true,
          lastErrorCode: 'CAPTURE_DELETION_FAILED',
          claimToken: null,
          claimExpiresAtTs: null,
          updatedAtTs: failedClock.value,
        },
      });
      if (failed.count === 0) return err(notFound('删除回执不存在'));
      const receipt = await prisma.captureDeletionReceipt.findFirst({ where: { id: receiptId, teacherId } });
      return ok(receiptView(receipt));
    }
  }
  return {
    async createText(input) {
      if (!validRequestId(input.clientRequestId)) return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      if (!input.text?.trim()) return err(validationError('文字输入不能为空', 'text'));
      const prisma = await getClient();
      const existing = await prisma.captureEvent.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } }, include: { tasks: { orderBy: { createdAtTs: 'asc' } }, candidate: true, deletionReceipt: true } });
      if (existing) {
        if (existing.redactedAtTs || existing.deletionReceipt || decryptFieldValue(cipher, existing.rawText ?? '') !== input.text) return err(versionConflict());
        return ok({ capture: captureView(existing, cipher), replayed: true });
      }
      const clock = await now(prisma); if (!clock.ok) return clock;
      try {
        const created = await prisma.$transaction(async (tx) => {
          const event = await tx.captureEvent.create({ data: { teacherId: input.teacherId, clientRequestId: input.clientRequestId, sourceType: 'text', sourceChannel: 'web', rawText: encryptFieldValue(cipher, input.text), occurredAtTs: clock.value, createdAtTs: clock.value } });
          const task = await tx.captureTask.create({ data: { teacherId: input.teacherId, eventId: event.id, taskType: TASK_TYPE, processorVersion: VERSION, status: 'completed', attemptCount: 1, retryable: false, startedAtTs: clock.value, completedAtTs: clock.value, createdAtTs: clock.value, updatedAtTs: clock.value } });
          await tx.captureCandidate.create({ data: { teacherId: input.teacherId, eventId: event.id, taskId: task.id, candidateType: 'verbatim_note', payload: json(encryptJsonFieldValue(cipher, { text: input.text })), reviewStatus: 'pending', confidence: null, candidateVersion: VERSION, createdAtTs: clock.value, updatedAtTs: clock.value } });
          return tx.captureEvent.findUniqueOrThrow({ where: { id: event.id }, include: { tasks: true, candidate: true } });
        });
        return ok({ capture: captureView(created, cipher), replayed: false });
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          const raced = await prisma.captureEvent.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } }, include: { tasks: true, candidate: true, deletionReceipt: true } });
          if (raced && !raced.redactedAtTs && !raced.deletionReceipt && decryptFieldValue(cipher, raced.rawText ?? '') === input.text) return ok({ capture: captureView(raced, cipher), replayed: true });
          return err(versionConflict());
        }
        throw caught;
      }
    },
    async get(input) {
      const event = await ownedActive(await getClient(), input.teacherId, input.eventId);
      return event ? ok(captureView(event, cipher)) : err(notFound('原始记录不存在'));
    },
    async requestDeletion(input) {
      if (!validRequestId(input.clientRequestId)) return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      const prisma = await getClient();
      const existing = await prisma.captureDeletionReceipt.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } } });
      if (existing) {
        if (existing.eventId !== input.eventId) return err(versionConflict());
        const recovered = await readReceiptWithRecovery(prisma, existing.id, input.teacherId);
        return recovered.ok ? ok({ receipt: receiptView(recovered.value), replayed: true }) : recovered;
      }
      const eventReceipt = await prisma.captureDeletionReceipt.findFirst({
        where: { teacherId: input.teacherId, eventId: input.eventId },
      });
      if (eventReceipt) {
        const recovered = await readReceiptWithRecovery(prisma, eventReceipt.id, input.teacherId);
        return recovered.ok ? ok({ receipt: receiptView(recovered.value), replayed: true }) : recovered;
      }
      const clock = await now(prisma); if (!clock.ok) return clock;
      let receipt: any;
      try {
        receipt = await prisma.$transaction(async (tx) => {
          const event = await tx.captureEvent.findFirst({ where: { id: input.eventId, teacherId: input.teacherId, redactedAtTs: null, deletionReceipt: null } });
          if (!event) return null;
          return tx.captureDeletionReceipt.create({ data: { teacherId: input.teacherId, eventId: input.eventId, clientRequestId: input.clientRequestId, status: 'pending', retryable: true, createdAtTs: clock.value, updatedAtTs: clock.value } });
        });
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          const replay = await prisma.captureDeletionReceipt.findFirst({
            where: {
              teacherId: input.teacherId,
              OR: [
                { clientRequestId: input.clientRequestId },
                { eventId: input.eventId },
              ],
            },
          });
          if (!replay) return err(notFound('原始记录不存在'));
          if (replay.clientRequestId === input.clientRequestId && replay.eventId !== input.eventId) return err(versionConflict());
          return ok({ receipt: receiptView(replay), replayed: true });
        }
        throw caught;
      }
      if (!receipt) return err(notFound('原始记录不存在'));
      const result = await executeDeletion(prisma, receipt.id, input.teacherId);
      return result.ok ? ok({ receipt: result.value, replayed: false }) : result;
    },
    async getDeletionReceipt(input) {
      const receipt = await readReceiptWithRecovery(await getClient(), input.receiptId, input.teacherId);
      return receipt.ok ? ok(receiptView(receipt.value)) : receipt;
    },
    async retryDeletion(input) {
      const prisma = await getClient();
      const recovered = await readReceiptWithRecovery(prisma, input.receiptId, input.teacherId);
      if (!recovered.ok) return recovered;
      if (recovered.value.status === 'completed') return ok({ receipt: receiptView(recovered.value), replayed: true });
      const result = await executeDeletion(prisma, recovered.value.id, input.teacherId);
      return result.ok ? ok({ receipt: result.value, replayed: false }) : result;
    },
    async confirmRecord(input) {
      if (!validRequestId(input.clientRequestId)) return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      if (!input.studentId?.trim()) return err(validationError('studentId 必填', 'studentId'));
      const prisma = await getClient();
      const clock = await now(prisma); if (!clock.ok) return clock;
      try {
        const result = await prisma.$transaction(async (tx) => {
          const candidate = await tx.captureCandidate.findFirst({
            where: { eventId: input.eventId, teacherId: input.teacherId },
            include: { event: { include: { deletionReceipt: true } } },
          });
          if (!candidate || candidate.event.redactedAtTs || candidate.event.deletionReceipt) return { kind: 'not_found' as const };

          // A same-request replay returns the originally confirmed record without
          // creating a second timeline item.
          if (candidate.confirmationRequestId === input.clientRequestId && candidate.confirmedRecordId) {
            const record = await tx.studentRecord.findFirst({ where: { id: candidate.confirmedRecordId, teacherId: input.teacherId } });
            if (record) return { kind: 'ok' as const, view: confirmedView(candidate, record, true) };
          }
          if (candidate.reviewStatus !== 'pending') return { kind: 'conflict' as const };

          const student = await tx.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
          if (!student) return { kind: 'not_found' as const };
          if (input.scheduleId) {
            const participant = await tx.scheduleParticipant.findFirst({
              where: { scheduleId: input.scheduleId, studentId: input.studentId, teacherId: input.teacherId, schedule: { teacherId: input.teacherId, status: 'completed' } },
              select: { id: true },
            });
            if (!participant) return { kind: 'not_found' as const };
          }

          const payload = decryptJsonFieldValue(cipher, candidate.payload) as { text?: unknown } | null;
          const text = typeof payload?.text === 'string' ? payload.text : '';
          if (!text) return { kind: 'conflict' as const };
          let source = await tx.studentSourceRecord.findFirst({
            where: { teacherId: input.teacherId, sourceEntityType: 'CaptureEvent', sourceEntityId: input.eventId },
          });
          if (!source) {
            source = await tx.studentSourceRecord.create({
              data: {
                teacherId: input.teacherId,
                studentId: input.studentId,
                sourceType: 'manual',
                sourceEntityType: 'CaptureEvent',
                sourceEntityId: input.eventId,
                rawText: encryptFieldValue(cipher, text),
                contentHash: createHash('sha256').update(text).digest('hex'),
                captureStatus: 'captured',
                occurredAtTs: candidate.event.occurredAtTs,
                createdAtTs: clock.value,
                updatedAtTs: clock.value,
              },
            });
          } else if (source.studentId !== input.studentId) {
            return { kind: 'conflict' as const };
          }

          let record = await tx.studentRecord.findFirst({ where: { teacherId: input.teacherId, sourceRecordId: source.id } });
          if (!record) {
            record = await tx.studentRecord.create({
              data: {
                teacherId: input.teacherId,
                studentId: input.studentId,
                sourceRecordId: source.id,
                category: input.scheduleId ? 'lesson_observation' : 'general_note',
                summary: encryptFieldValue(cipher, text),
                structuredData: encryptJsonFieldValue(cipher, input.scheduleId ? { scheduleId: input.scheduleId, captureEventId: input.eventId } : { captureEventId: input.eventId }) as unknown as Prisma.InputJsonValue,
                confidence: 'high',
                reviewStatus: 'confirmed',
                visibility: 'internal_only',
                importance: 'normal',
                occurredAtTs: candidate.event.occurredAtTs,
                createdAtTs: clock.value,
                updatedAtTs: clock.value,
              },
            });
          }
          const marked = await tx.captureCandidate.updateMany({
            where: { id: candidate.id, teacherId: input.teacherId, reviewStatus: 'pending', confirmationRequestId: null },
            data: { reviewStatus: 'confirmed', confirmationRequestId: input.clientRequestId, confirmedRecordId: record.id, confirmedAtTs: clock.value, updatedAtTs: clock.value },
          });
          if (marked.count !== 1) return { kind: 'conflict' as const };
          await requireChangelogWrite(defaultChangelogFactory(tx).recordChange({
            teacherId: input.teacherId,
            module: 'student-records',
            action: 'create',
            targetType: 'StudentRecord',
            targetId: record.id,
            before: null,
            after: { category: record.category, reviewStatus: record.reviewStatus, sourceRecordId: source.id },
            source: 'manual',
          }));
          return { kind: 'ok' as const, view: confirmedView(candidate, record, false, input.scheduleId ?? null) };
        });
        if (result.kind === 'not_found') return err(notFound('原始记录不存在'));
        if (result.kind === 'conflict') return err(versionConflict());
        return ok(result.view);
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') return err(versionConflict());
        throw caught;
      }
    },
  };
}

function confirmedView(candidate: any, record: any, replayed: boolean, scheduleId?: string | null): ConfirmedCaptureRecordView {
  const structured = record.structuredData && typeof record.structuredData === 'object' && !Array.isArray(record.structuredData)
    ? record.structuredData as { scheduleId?: unknown }
    : {};
  return {
    eventId: candidate.eventId,
    candidateId: candidate.id,
    recordId: record.id,
    studentId: record.studentId,
    scheduleId: scheduleId ?? (typeof structured.scheduleId === 'string' ? structured.scheduleId : null),
    category: record.category === 'lesson_observation' ? 'lesson_observation' : 'general_note',
    replayed,
  };
}
