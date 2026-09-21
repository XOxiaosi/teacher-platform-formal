import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { err, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import { createFieldCipherFromEnv, decryptFieldValue, encryptFieldValue, encryptJsonFieldValue } from '../../shared/field-encryption/index.js';
import { captureView, captureInclude, lockCaptureEvent, invalidateCaptureSources, captureWriteClock, createCandidateOperations, matchesCandidateInput, loadConfirmedRecords } from './capture-candidates.js';
import { createConfirmCaptureRecord } from './capture-confirm-record.js';
import type { CaptureService, CreateCaptureServiceOptions, DeletionReceiptView } from './types.js';

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TASK_TYPE = 'text_verbatim_candidate';
const VERSION = 'text-verbatim-v1';
const DELETION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const DELETION_INTERRUPTED = 'CAPTURE_DELETION_INTERRUPTED';

function validRequestId(value: string) { return REQUEST_ID.test(value); }
function json(value: unknown) { return value as Prisma.InputJsonValue; }
function receiptView(row: any): DeletionReceiptView {
  return { id: row.id, eventId: row.eventId, status: row.status, attemptCount: row.attemptCount, retryable: row.retryable, lastErrorCode: row.lastErrorCode, createdAt: row.createdAtTs, completedAt: row.completedAtTs };
}
async function ownedActive(prisma: PrismaClient, teacherId: string, eventId: string) {
  return prisma.captureEvent.findFirst({ where: { id: eventId, teacherId, redactedAtTs: null, deletionReceipt: null }, include: captureInclude });
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
        await tx.captureCandidate.updateMany({ where: { eventId: receipt.eventId, teacherId }, data: { payload: Prisma.DbNull, originalPayload: Prisma.DbNull, redactedAtTs: completedClock.value, updatedAtTs: completedClock.value } });
        await invalidateCaptureSources(tx, teacherId, receipt.eventId, completedClock.value);
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
    ...createCandidateOperations(getClient, cipher),
    async createText(input) {
      if (!validRequestId(input.clientRequestId)) return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      if (!input.text?.trim()) return err(validationError('文字输入不能为空', 'text'));
      if (input.candidates !== undefined && (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.some(item => !item || typeof item.text !== 'string' || !item.text.trim()))) return err(validationError('候选内容不能为空', 'candidates'));
      const prisma = await getClient();
      const existing = await prisma.captureEvent.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } }, include: { ...captureInclude, deletionReceipt: true } });
      if (existing) {
        if (existing.redactedAtTs || existing.deletionReceipt || (decryptFieldValue(cipher, existing.rawText ?? '') !== input.text || !matchesCandidateInput(existing, input.candidates, cipher))) return err(versionConflict());
        const records = await loadConfirmedRecords(prisma, input.teacherId, [existing]);
        return ok({ capture: captureView(existing, cipher, records), replayed: true });
      }
      const clock = await now(prisma); if (!clock.ok) return clock;
      try {
        const created = await prisma.$transaction(async (tx) => {
          const event = await tx.captureEvent.create({ data: { teacherId: input.teacherId, clientRequestId: input.clientRequestId, sourceType: 'text', sourceChannel: 'web', rawText: encryptFieldValue(cipher, input.text), occurredAtTs: clock.value, createdAtTs: clock.value } });
          const task = await tx.captureTask.create({ data: { teacherId: input.teacherId, eventId: event.id, taskType: TASK_TYPE, processorVersion: input.candidates ? 'manual-candidates-v1' : VERSION, status: 'completed', attemptCount: 1, retryable: false, startedAtTs: clock.value, completedAtTs: clock.value, createdAtTs: clock.value, updatedAtTs: clock.value } });
          for (const [position, item] of (input.candidates ?? [{ text: input.text }]).entries()) {
            const payload = json(encryptJsonFieldValue(cipher, item));
            await tx.captureCandidate.create({ data: { teacherId: input.teacherId, eventId: event.id, taskId: task.id, position, candidateType: 'verbatim_note', payload, originalPayload: payload, reviewStatus: 'pending', confidence: null, candidateVersion: VERSION, createdAtTs: clock.value, updatedAtTs: clock.value } });
          }
          return tx.captureEvent.findUniqueOrThrow({ where: { id: event.id }, include: captureInclude });
        });
        const records = await loadConfirmedRecords(prisma, input.teacherId, [created]);
        return ok({ capture: captureView(created, cipher, records), replayed: false });
      } catch (caught) {
        if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
          const raced = await prisma.captureEvent.findUnique({ where: { teacherId_clientRequestId: { teacherId: input.teacherId, clientRequestId: input.clientRequestId } }, include: { ...captureInclude, deletionReceipt: true } });
          if (raced && !raced.redactedAtTs && !raced.deletionReceipt && decryptFieldValue(cipher, raced.rawText ?? '') === input.text && matchesCandidateInput(raced, input.candidates, cipher)) {
            const records = await loadConfirmedRecords(prisma, input.teacherId, [raced]);
            return ok({ capture: captureView(raced, cipher, records), replayed: true });
          }
          return err(versionConflict());
        }
        throw caught;
      }
    },
    async get(input) {
      const prisma = await getClient();
      const event = await ownedActive(prisma, input.teacherId, input.eventId);
      if (!event) return err(notFound('原始记录不存在'));
      const records = await loadConfirmedRecords(prisma, input.teacherId, [event]);
      return ok(captureView(event, cipher, records));
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
          await lockCaptureEvent(tx, input.teacherId, input.eventId);
          const writeClock = await captureWriteClock(tx);
          if (!writeClock.ok) throw new Error(writeClock.error.message);
          const prior = await tx.captureDeletionReceipt.findFirst({ where: { eventId: input.eventId, teacherId: input.teacherId } });
          if (prior) return { receipt: prior, replayed: true };
          const event = await tx.captureEvent.findFirst({ where: { id: input.eventId, teacherId: input.teacherId, redactedAtTs: null, deletionReceipt: null } });
          if (!event) return null;
          const created = await tx.captureDeletionReceipt.create({ data: { teacherId: input.teacherId, eventId: input.eventId, clientRequestId: input.clientRequestId, status: 'pending', retryable: true, createdAtTs: writeClock.value, updatedAtTs: writeClock.value } });
          await invalidateCaptureSources(tx, input.teacherId, input.eventId, writeClock.value);
          return { receipt: created, replayed: false };
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
      if (receipt.replayed) {
        const recovered = await readReceiptWithRecovery(prisma, receipt.receipt.id, input.teacherId);
        return recovered.ok ? ok({ receipt: receiptView(recovered.value), replayed: true }) : recovered;
      }
      const result = await executeDeletion(prisma, receipt.receipt.id, input.teacherId);
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
    confirmRecord: createConfirmCaptureRecord(getClient, cipher),
  };
}
