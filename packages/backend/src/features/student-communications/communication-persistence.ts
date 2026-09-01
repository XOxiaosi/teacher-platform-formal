import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Logger } from '../../shared/logger/index.js';
import type { ModerationAdapter } from '../../shared/platform-services/index.js';
import {
  decryptFieldValue, decryptJsonFieldValue, encryptFieldValue, encryptJsonFieldValue,
  type FieldCipher,
} from '../../shared/field-encryption/index.js';
import { createChangelogService } from '../../shared/changelog/changelog-service.js';
import { moderateCommunicationProjection } from './communication-moderation.js';
import type {
  CommunicationDetailData, CreateCommunicationRecordInput, StudentRecordData,
} from './types.js';

export type CommunicationChangelogFactory = (
  prisma: Prisma.TransactionClient,
) => Pick<ReturnType<typeof createChangelogService>, 'recordChange'>;

async function requireAudit(
  prisma: Prisma.TransactionClient,
  input: Parameters<ReturnType<typeof createChangelogService>['recordChange']>[0],
  changelogFactory: CommunicationChangelogFactory,
): Promise<void> {
  const result = await changelogFactory(prisma).recordChange(input);
  if (!result.ok) throw new Error('AUDIT_WRITE_FAILED');
}

export async function createCommunicationRecordInternal(
  prisma: Prisma.TransactionClient,
  input: CreateCommunicationRecordInput,
  now: Date,
  cipher: FieldCipher | undefined,
  moderation: ModerationAdapter | undefined,
  logger: Logger | undefined,
  auditSource: 'manual' | 'agent',
  changelogFactory: CommunicationChangelogFactory,
): Promise<{ record: StudentRecordData; detail: CommunicationDetailData }> {
  let sourceId: string | null = null;
  if (typeof input.sourceText === 'string' && input.sourceText.trim() !== '') {
    const contentHash = createHash('sha256').update(input.sourceText).digest('hex');
    let sourceRecord = await prisma.studentSourceRecord.findFirst({
      where: { teacherId: input.teacherId, studentId: input.studentId, contentHash },
    });
    if (!sourceRecord) {
      sourceRecord = await prisma.studentSourceRecord.create({ data: {
        teacherId: input.teacherId, studentId: input.studentId, sourceType: 'agent_text',
        occurredAtTs: now, captureStatus: 'captured', rawText: encryptFieldValue(cipher, input.sourceText),
        contentHash, createdAtTs: now, updatedAtTs: now,
      } });
      await requireAudit(prisma, {
        teacherId: input.teacherId, module: 'student-source-record', action: 'create',
        targetType: 'StudentSourceRecord', targetId: sourceRecord.id, before: null,
        after: { sourceType: 'agent_text', studentId: input.studentId }, source: auditSource,
      }, changelogFactory);
    }
    sourceId = sourceRecord.id;
  }

  const summary = input.summary.trim();
  const reviewStatus = input.reviewStatus ?? 'candidate';
  const visibility = input.visibility ?? 'needs_review';
  const encryptedSummary = encryptFieldValue(cipher, summary);
  const record = await prisma.studentRecord.create({ data: {
    teacherId: input.teacherId, studentId: input.studentId, sourceRecordId: sourceId,
    category: 'parent_communication', occurredAtTs: input.occurredAt ?? now,
    summary: encryptedSummary, structuredData: Prisma.JsonNull, confidence: 'medium',
    reviewStatus, visibility, importance: 'normal', supersedesId: null,
    createdAtTs: now, updatedAtTs: now,
  } });
  await requireAudit(prisma, {
    teacherId: input.teacherId, module: 'student-records', action: 'create',
    targetType: 'StudentRecord', targetId: record.id, before: null,
    after: { category: 'parent_communication', summary: encryptedSummary, studentId: input.studentId, reviewStatus, visibility },
    source: auditSource,
  }, changelogFactory);

  const arrays = {
    parentConcerns: input.parentConcerns ?? [], teacherResponses: input.teacherResponses ?? [],
    agreements: input.agreements ?? [], followUps: input.followUps ?? [],
  };
  const moderationResult = await moderateCommunicationProjection({
    moderation, logger, teacherId: input.teacherId, recordId: record.id,
    projection: { summary, sourceText: input.sourceText, ...arrays },
  });
  const detail = await prisma.communicationDetail.create({ data: {
    teacherId: input.teacherId, studentRecordId: record.id, direction: input.direction,
    channel: input.channel ?? null, parentType: input.parentType ?? null,
    parentConcerns: encryptJsonFieldValue(cipher, arrays.parentConcerns) as unknown as Prisma.InputJsonValue,
    teacherResponses: encryptJsonFieldValue(cipher, arrays.teacherResponses) as unknown as Prisma.InputJsonValue,
    agreements: encryptJsonFieldValue(cipher, arrays.agreements) as unknown as Prisma.InputJsonValue,
    followUps: encryptJsonFieldValue(cipher, arrays.followUps) as unknown as Prisma.InputJsonValue,
    nextContactAtTs: input.nextContactAtTs ?? null,
    moderationFlagged: moderationResult?.flagged ?? null,
    moderationReasons: moderationResult ? moderationResult.reasons as Prisma.InputJsonValue : Prisma.DbNull,
    createdAtTs: now, updatedAtTs: now,
  } });
  await requireAudit(prisma, {
    teacherId: input.teacherId, module: 'student-communications', action: 'create',
    targetType: 'CommunicationDetail', targetId: detail.id, before: null,
    after: {
      studentRecordId: record.id, direction: detail.direction, channel: detail.channel,
      parentType: detail.parentType, moderationFlagged: detail.moderationFlagged,
      moderationReasons: detail.moderationReasons,
    }, source: auditSource,
  }, changelogFactory);
  return { record: toStudentRecordData(record, cipher), detail: toCommunicationDetailData(detail, cipher) };
}

function toStudentRecordData(record: any, cipher: FieldCipher | undefined): StudentRecordData {
  return {
    id: record.id, teacherId: record.teacherId, studentId: record.studentId,
    sourceRecordId: record.sourceRecordId, category: record.category,
    occurredAt: record.occurredAtTs, summary: decryptFieldValue(cipher, record.summary),
    structuredData: record.structuredData == null ? null : record.structuredData as Record<string, unknown>,
    confidence: record.confidence, reviewStatus: record.reviewStatus, visibility: record.visibility,
    importance: record.importance, supersedesId: record.supersedesId,
    createdAt: record.createdAtTs, updatedAt: record.updatedAtTs,
  };
}

export function toCommunicationDetailData(record: any, cipher: FieldCipher | undefined): CommunicationDetailData {
  return {
    id: record.id, teacherId: record.teacherId, studentRecordId: record.studentRecordId,
    direction: record.direction, channel: record.channel, parentType: record.parentType,
    parentConcerns: decryptJsonFieldValue(cipher, record.parentConcerns) as string[],
    teacherResponses: decryptJsonFieldValue(cipher, record.teacherResponses) as string[],
    agreements: decryptJsonFieldValue(cipher, record.agreements) as string[],
    followUps: decryptJsonFieldValue(cipher, record.followUps) as string[],
    nextContactAtTs: record.nextContactAtTs, moderationFlagged: record.moderationFlagged,
    moderationReasons: Array.isArray(record.moderationReasons)
      ? record.moderationReasons.filter((reason: unknown): reason is string => typeof reason === 'string') : null,
    createdAtTs: record.createdAtTs, updatedAtTs: record.updatedAtTs,
  };
}
