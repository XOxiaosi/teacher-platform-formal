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
type ConfirmedRecordProjection = {
  id: string;
  studentId: string;
  reviewStatus: string;
  visibility: string;
  updatedAtTs: Date;
  structuredData: Prisma.JsonValue | null;
  student: { teacherId: string } | null;
};
type ConfirmedRecordMap = ReadonlyMap<string, ConfirmedRecordProjection>;

/** Load all referenced records in one tenant-scoped query. Missing or corrupt references stay null. */
export async function loadConfirmedRecords(
  prisma: PrismaClient | Prisma.TransactionClient,
  teacherId: string,
  rows: CaptureRow[],
): Promise<ConfirmedRecordMap> {
  const ids = [...new Set(rows.flatMap(row => row.candidates.map(candidate => candidate.confirmedRecordId).filter((id): id is string => Boolean(id))))];
  if (ids.length === 0) return new Map();
  const records = await prisma.studentRecord.findMany({
    where: { teacherId, id: { in: ids }, student: { teacherId } },
    select: {
      id: true,
      studentId: true,
      reviewStatus: true,
      visibility: true,
      updatedAtTs: true,
      structuredData: true,
      student: { select: { teacherId: true } },
    },
  });
  return new Map(records.map(record => [record.id, record]));
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
export function captureView(row: CaptureRow, cipher: FieldCipher | undefined, records: ConfirmedRecordMap = new Map()): CaptureView {
  const candidates = row.candidates.map((candidate): CaptureCandidateView => ({
    id: candidate.id, candidateType: 'verbatim_note',
    payload: decryptJsonFieldValue(cipher, candidate.payload) as { text: string },
    originalPayload: decryptJsonFieldValue(cipher, candidate.originalPayload ?? candidate.payload) as { text: string },
    reviewStatus: candidate.reviewStatus as CaptureCandidateView['reviewStatus'], version: candidate.revision,
    confirmedRecordId: candidate.confirmedRecordId,
    confirmedRecord: projectConfirmedRecord(row.id, row.candidates.length, candidate, records, cipher),
    confidence: null,
  }));
  return {
    id: row.id, sourceType: 'text', sourceChannel: 'web', rawText: decryptFieldValue(cipher, row.rawText ?? ''),
    occurredAt: row.occurredAtTs, createdAt: row.createdAtTs,
    task: { id: row.tasks[0].id, status: row.tasks[0].status, processorVersion: row.tasks[0].processorVersion },
    confirmedRecordId: candidates[0]?.confirmedRecordId ?? null, candidate: candidates[0], candidates,
  };
}

function projectConfirmedRecord(
  eventId: string,
  candidateCount: number,
  candidate: CaptureRow['candidates'][number],
  records: ConfirmedRecordMap,
  cipher: FieldCipher | undefined,
): CaptureCandidateView['confirmedRecord'] {
  if (!candidate.confirmedRecordId) return null;
  const record = records.get(candidate.confirmedRecordId);
  if (!record || record.student?.teacherId !== candidate.teacherId) return null;
  const reviewStatus = ['candidate', 'confirmed', 'rejected', 'superseded'].includes(record.reviewStatus)
    ? record.reviewStatus as NonNullable<CaptureCandidateView['confirmedRecord']>['reviewStatus']
    : null;
  const visibility = ['internal_only', 'parent_shareable', 'needs_review'].includes(record.visibility)
    ? record.visibility as NonNullable<CaptureCandidateView['confirmedRecord']>['visibility']
    : null;
  if (!reviewStatus || !visibility) return null;
  try {
    const source = decryptJsonFieldValue(cipher, record.structuredData) as {
      captureEventId?: unknown;
      captureCandidateId?: unknown;
    } | null;
    const eventMatches = source?.captureEventId === eventId;
    const candidateMatches = source?.captureCandidateId === candidate.id;
    const legacySingleCandidateMatches = source?.captureCandidateId === undefined && candidateCount === 1;
    if (!eventMatches || (!candidateMatches && !legacySingleCandidateMatches)) return null;
  } catch {
    return null;
  }
  return { id: record.id, studentId: record.studentId, reviewStatus, visibility, updatedAt: record.updatedAtTs };
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
      const records = await loadConfirmedRecords(tx, input.teacherId, [updated]);
      return ok(captureView(updated, cipher, records));
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
      const page = rows.slice(0, limit);
      const records = await loadConfirmedRecords(prisma, input.teacherId, page);
      return ok({ items: page.map(row => captureView(row, cipher, records)), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
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
