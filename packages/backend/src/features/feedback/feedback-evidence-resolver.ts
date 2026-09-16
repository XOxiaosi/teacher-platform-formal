import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { err, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { decryptFieldValue, decryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import type { FeedbackEvidenceSnapshotInput } from './types.js';

export const feedbackRecordInclude = {
  assessment: true, communicationDetail: true,
  sourceRecord: { select: { captureStatus: true } },
} satisfies Prisma.StudentRecordInclude;
type EvidenceRecord = Prisma.StudentRecordGetPayload<{ include: typeof feedbackRecordInclude }>;
export interface ResolvedFeedbackEvidence extends FeedbackEvidenceSnapshotInput {
  id: string;
  type: 'record' | 'assessment';
  sourceVersion: string;
  originalDeleted: boolean;
  category: string;
  summary: string;
  examName: string | null;
  subject: string | null;
  score: number | null;
  fullScore: number | null;
  previousScore: number | null;
}

export function projectFeedbackEvidence(record: EvidenceRecord, cipher: FieldCipher | undefined): ResolvedFeedbackEvidence {
  const assessment = record.assessment;
  const communication = record.communicationDetail;
  const evidence = {
    id: record.id, type: record.category === 'assessment' ? 'assessment' as const : 'record' as const,
    occurredAt: record.occurredAtTs.toISOString(), category: record.category,
    summary: decryptFieldValue(cipher, record.summary),
    examName: assessment?.examName == null ? null : decryptFieldValue(cipher, assessment.examName),
    subject: assessment?.subject == null ? null : decryptFieldValue(cipher, assessment.subject),
    score: assessment?.score ?? null, fullScore: assessment?.fullScore ?? null, previousScore: assessment?.previousScore ?? null,
    parentConcerns: communication ? (decryptJsonFieldValue(cipher, communication.parentConcerns) as string[] | null) ?? [] : [],
    followUps: communication ? (decryptJsonFieldValue(cipher, communication.followUps) as string[] | null) ?? [] : [],
  };
  // Raw source deletion does not revoke the independently confirmed fact.
  // It changes the provenance label, never restores the deleted source text.
  const sourceVersion = createHash('sha256').update(JSON.stringify({ evidence,
    teacherId: record.teacherId, studentId: record.studentId, updatedAt: record.updatedAtTs.toISOString(),
    reviewStatus: record.reviewStatus, visibility: record.visibility,
    structuredData: decryptJsonFieldValue(cipher, record.structuredData),
    assessmentUpdatedAt: assessment?.updatedAtTs.toISOString(), communicationUpdatedAt: communication?.updatedAtTs.toISOString(),
  })).digest('hex');
  return { ...evidence, sourceVersion, originalDeleted: record.sourceRecord?.captureStatus === 'deleted' };
}

/** Caller must pass the same transaction used for feedback writes when lock=true.
 * FOR UPDATE also fences new child detail inserts via their foreign-key lock. */
export async function resolveFeedbackEvidence(input: {
  client: Prisma.TransactionClient;
  teacherId: string;
  studentId: string;
  references: readonly Pick<FeedbackEvidenceSnapshotInput, 'id' | 'type' | 'sourceVersion'>[];
  cipher?: FieldCipher;
  lock?: boolean;
}) {
  if (input.references.some(ref => !ref.id?.trim() || !['assessment', 'record'].includes(ref.type))) {
    return err(validationError('反馈依据必须引用已确认且可用于家长材料的正式记录', 'evidence'));
  }
  const ids = input.references.map(ref => ref.id!);
  if (new Set(ids).size !== ids.length) return err(validationError('反馈依据不能重复', 'evidence'));
  if (ids.length === 0) return ok([] as ResolvedFeedbackEvidence[]);
  if (input.lock) {
    await input.client.$queryRaw(Prisma.sql`SELECT "id" FROM "StudentRecord"
      WHERE "teacherId" = ${input.teacherId} AND "studentId" = ${input.studentId}
      AND "id" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR UPDATE`);
    for (const table of ['AssessmentDetail', 'CommunicationDetail']) {
      await input.client.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
        WHERE "teacherId" = ${input.teacherId} AND "studentRecordId" IN (${Prisma.join([...ids].sort())}) ORDER BY "id" FOR UPDATE`);
    }
  }
  const records = await input.client.studentRecord.findMany({ where: {
    id: { in: ids }, teacherId: input.teacherId, studentId: input.studentId,
    reviewStatus: 'confirmed', visibility: 'parent_shareable',
  }, include: feedbackRecordInclude });
  if (records.length !== ids.length) return err(versionConflict());
  const byId = new Map(records.map(record => [record.id, record]));
  const result: ResolvedFeedbackEvidence[] = [];
  for (const ref of input.references) {
    const row = byId.get(ref.id!)!;
    if ((row.assessment && row.assessment.teacherId !== input.teacherId)
      || (row.communicationDetail && row.communicationDetail.teacherId !== input.teacherId)) return err(versionConflict());
    const item = projectFeedbackEvidence(row, input.cipher);
    if (item.type !== ref.type || (ref.sourceVersion !== undefined && ref.sourceVersion !== item.sourceVersion)) return err(versionConflict());
    result.push(item);
  }
  return ok(result);
}
