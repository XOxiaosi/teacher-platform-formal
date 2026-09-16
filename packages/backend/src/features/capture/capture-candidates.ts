import type { Prisma, PrismaClient } from '@prisma/client';
import { err, internalError, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { decryptFieldValue, decryptJsonFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import type { CaptureCandidateIdentity, CaptureCandidateView, CaptureService, CaptureView } from './types.js';

export const captureInclude = { tasks: { orderBy: { createdAtTs: 'asc' as const } }, candidates: { orderBy: { position: 'asc' as const } } } satisfies Prisma.CaptureEventInclude;
type CaptureRow = Prisma.CaptureEventGetPayload<{ include: typeof captureInclude }>;
export async function lockCaptureEvent(tx: Prisma.TransactionClient, teacherId: string, eventId: string) {
  await tx.$queryRaw`SELECT "id" FROM "CaptureEvent" WHERE "id" = ${eventId} AND "teacherId" = ${teacherId} FOR UPDATE`;
}
export async function captureWriteClock(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT statement_timestamp() AS "now"`;
  const at = rows[0]?.now;
  return at instanceof Date && !Number.isNaN(at.getTime()) ? ok(at) : err(internalError('数据库可信时间不可用'));
}
export async function invalidateCaptureSources(tx: Prisma.TransactionClient, teacherId: string, eventId: string, at: Date) {
  const ids = (await tx.captureCandidate.findMany({ where: { eventId, teacherId }, select: { id: true } })).map(item => item.id);
  await tx.studentSourceRecord.updateMany({ where: {
    teacherId, captureStatus: { not: 'deleted' }, OR: [
      { sourceEntityType: 'CaptureEvent', sourceEntityId: eventId },
      { sourceEntityType: 'CaptureCandidate', sourceEntityId: { in: ids } },
    ],
  }, data: { rawText: null, captureStatus: 'deleted', updatedAtTs: at } });
}
export function captureView(row: CaptureRow, cipher: FieldCipher | undefined): CaptureView {
  const candidates = row.candidates.map((candidate): CaptureCandidateView => ({
    id: candidate.id, candidateType: 'verbatim_note',
    payload: decryptJsonFieldValue(cipher, candidate.payload) as { text: string },
    originalPayload: decryptJsonFieldValue(cipher, candidate.originalPayload ?? candidate.payload) as { text: string },
    reviewStatus: candidate.reviewStatus as CaptureCandidateView['reviewStatus'], version: candidate.revision,
    confirmedRecordId: candidate.confirmedRecordId, confidence: null,
  }));
  return {
    id: row.id, sourceType: 'text', sourceChannel: 'web', rawText: decryptFieldValue(cipher, row.rawText ?? ''),
    occurredAt: row.occurredAtTs, createdAt: row.createdAtTs,
    task: { id: row.tasks[0].id, status: row.tasks[0].status, processorVersion: row.tasks[0].processorVersion },
    confirmedRecordId: candidates[0]?.confirmedRecordId ?? null, candidate: candidates[0], candidates,
  };
}
export function matchesCandidateInput(row: CaptureRow, candidates: { text: string }[] | undefined, cipher: FieldCipher | undefined) {
  if (candidates === undefined) return row.tasks[0]?.processorVersion !== 'manual-candidates-v1';
  return row.tasks[0]?.processorVersion === 'manual-candidates-v1' && candidates.length === row.candidates.length && candidates.every((item, index) => {
    const original = decryptJsonFieldValue(cipher, row.candidates[index].originalPayload ?? row.candidates[index].payload) as { text: string };
    return item.text === original.text;
  });
}
export function createCandidateOperations(getClient: () => Promise<PrismaClient>, cipher: FieldCipher | undefined): Pick<CaptureService, 'list' | 'editCandidate' | 'reviewCandidate'> {
  async function mutate(input: CaptureCandidateIdentity, change: { text: string } | { action: 'reject' | 'defer' }) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) return err(validationError('候选版本不合法', 'version'));
    const prisma = await getClient();
    return prisma.$transaction(async tx => {
      await lockCaptureEvent(tx, input.teacherId, input.eventId);
      const clock = await captureWriteClock(tx); if (!clock.ok) return clock;
      const event = await tx.captureEvent.findFirst({ where: { id: input.eventId, teacherId: input.teacherId, redactedAtTs: null, deletionReceipt: null }, include: captureInclude });
      const candidate = event?.candidates.find(item => item.id === input.candidateId && item.teacherId === input.teacherId);
      if (!event || !candidate || candidate.redactedAtTs) return err(notFound('原始记录或候选不存在'));
      if (candidate.revision !== input.version || !['pending', 'deferred'].includes(candidate.reviewStatus)) return err(versionConflict());
      await tx.captureCandidate.update({ where: { id: candidate.id }, data: {
        ...('text' in change ? { payload: encryptJsonFieldValue(cipher, { text: change.text }) as Prisma.InputJsonValue, reviewStatus: 'pending' } : { reviewStatus: change.action === 'reject' ? 'rejected' : 'deferred' }),
        revision: { increment: 1 }, updatedAtTs: clock.value,
      } });
      const updated = await tx.captureEvent.findUniqueOrThrow({ where: { id: event.id }, include: captureInclude });
      return ok(captureView(updated, cipher));
    });
  }
  return {
    async list(input) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(validationError('分页数量须为 1 至 100', 'limit'));
      const prisma = await getClient();
      const cursor = input.cursor ? await prisma.captureEvent.findFirst({ where: { id: input.cursor, teacherId: input.teacherId }, select: { id: true, createdAtTs: true } }) : null;
      if (input.cursor && !cursor) return err(notFound('分页位置不存在'));
      const rows = await prisma.captureEvent.findMany({
        where: { teacherId: input.teacherId, redactedAtTs: null, deletionReceipt: null, ...(cursor ? { OR: [{ createdAtTs: { lt: cursor.createdAtTs } }, { createdAtTs: cursor.createdAtTs, id: { lt: cursor.id } }] } : {}) },
        include: captureInclude, orderBy: [{ createdAtTs: 'desc' }, { id: 'desc' }], take: limit + 1,
      });
      return ok({ items: rows.slice(0, limit).map(row => captureView(row, cipher)), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
    },
    async editCandidate(input) {
      if (typeof input.text !== 'string' || !input.text.trim()) return err(validationError('候选内容不能为空', 'text'));
      return mutate(input, { text: input.text });
    },
    async reviewCandidate(input) {
      if (!['reject', 'defer'].includes(input.action)) return err(validationError('核对操作不合法', 'action'));
      return mutate(input, { action: input.action });
    },
  };
}
