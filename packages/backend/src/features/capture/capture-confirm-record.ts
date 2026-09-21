import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { err, notFound, ok, validationError, versionConflict } from '@teacher-platform/contracts';
import { decryptFieldValue, decryptJsonFieldValue, encryptFieldValue, encryptJsonFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import { defaultChangelogFactory, requireChangelogWrite } from '../../shared/changelog/index.js';
import { captureInclude, lockCaptureEvent, captureWriteClock } from './capture-candidates.js';
import type { CaptureRecordVisibility, CaptureService, ConfirmedCaptureRecordView } from './types.js';

export function createConfirmCaptureRecord(getClient: () => Promise<PrismaClient>, cipher: FieldCipher | undefined): CaptureService['confirmRecord'] {
  return async input => {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.clientRequestId)) return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
    if (!input.studentId?.trim()) return err(validationError('studentId 必填', 'studentId'));
    const visibility: CaptureRecordVisibility = input.visibility ?? 'internal_only';
    if (visibility !== 'internal_only' && visibility !== 'parent_shareable') return err(validationError('visibility 格式不合法', 'visibility'));
    if (input.candidateId && (!Number.isSafeInteger(input.version) || input.version! < 1)) return err(validationError('候选版本必填', 'version'));
    const prisma = await getClient();
    try {
      return await prisma.$transaction(async tx => {
        await lockCaptureEvent(tx, input.teacherId, input.eventId);
        const clock = await captureWriteClock(tx); if (!clock.ok) return clock;
        const event = await tx.captureEvent.findFirst({ where: { id: input.eventId, teacherId: input.teacherId, redactedAtTs: null, deletionReceipt: null }, include: captureInclude });
        if (!event) return err(notFound('原始记录不存在'));
        if (!input.candidateId && event.candidates.length !== 1) return err(versionConflict());
        const candidate = input.candidateId ? event.candidates.find(item => item.id === input.candidateId) : event.candidates[0];
        if (!candidate || candidate.teacherId !== input.teacherId || candidate.redactedAtTs) return err(notFound('候选不存在'));
        if (candidate.confirmationRequestId === input.clientRequestId && candidate.confirmedRecordId) {
          if (input.version !== undefined && input.version !== (candidate.confirmationRevision ?? 1)) return err(versionConflict());
          const record = await tx.studentRecord.findFirst({ where: { id: candidate.confirmedRecordId, teacherId: input.teacherId } });
          if (!record) return err(versionConflict());
          const structured = decryptJsonFieldValue(cipher, record.structuredData) as { scheduleId?: string } | null;
          if (record.studentId !== input.studentId || (structured?.scheduleId ?? null) !== (input.scheduleId ?? null) || record.visibility !== visibility) return err(versionConflict());
          return ok(view(candidate, record, input.scheduleId ?? null, true));
        }
        if (!['pending', 'deferred'].includes(candidate.reviewStatus) || (input.version !== undefined && input.version !== candidate.revision)) return err(versionConflict());
        // An old caller cannot approve content revised on another device without a version.
        if (!input.candidateId && candidate.revision !== 1) return err(versionConflict());
        const student = await tx.student.findFirst({ where: { id: input.studentId, teacherId: input.teacherId }, select: { id: true } });
        if (!student) return err(notFound('学生不存在'));
        if (input.scheduleId) {
          const participant = await tx.scheduleParticipant.findFirst({ where: { scheduleId: input.scheduleId, studentId: input.studentId, teacherId: input.teacherId, schedule: { teacherId: input.teacherId, status: 'completed' } }, select: { id: true } });
          if (!participant) return err(notFound('课程或学生参与记录不存在'));
        }
        const payload = decryptJsonFieldValue(cipher, candidate.payload) as { text?: string } | null;
        if (!payload?.text?.trim()) return err(versionConflict());
        const sourceType = event.candidates.length === 1 ? 'CaptureEvent' : 'CaptureCandidate';
        const sourceId = event.candidates.length === 1 ? event.id : candidate.id;
        const sourceText = decryptFieldValue(cipher, event.rawText ?? '');
        let source = await tx.studentSourceRecord.findFirst({ where: { teacherId: input.teacherId, sourceEntityType: sourceType, sourceEntityId: sourceId } });
        if (source && (source.studentId !== input.studentId || source.captureStatus !== 'captured')) return err(versionConflict());
        if (!source) source = await tx.studentSourceRecord.create({ data: {
          teacherId: input.teacherId, studentId: input.studentId, sourceType: 'manual', sourceEntityType: sourceType, sourceEntityId: sourceId,
          rawText: encryptFieldValue(cipher, sourceText), contentHash: createHash('sha256').update(sourceText).digest('hex'), captureStatus: 'captured',
          occurredAtTs: event.occurredAtTs, createdAtTs: clock.value, updatedAtTs: clock.value,
        } });
        const record = await tx.studentRecord.create({ data: {
          teacherId: input.teacherId, studentId: input.studentId, sourceRecordId: source.id,
          category: input.scheduleId ? 'lesson_observation' : 'general_note', summary: encryptFieldValue(cipher, payload.text),
          structuredData: encryptJsonFieldValue(cipher, { captureEventId: event.id, captureCandidateId: candidate.id, ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}) }) as Prisma.InputJsonValue,
          confidence: 'high', reviewStatus: 'confirmed', visibility, importance: 'normal',
          occurredAtTs: event.occurredAtTs, createdAtTs: clock.value, updatedAtTs: clock.value,
        } });
        await tx.captureCandidate.update({ where: { id: candidate.id }, data: {
          reviewStatus: 'confirmed', revision: { increment: 1 }, confirmationRevision: candidate.revision, confirmationRequestId: input.clientRequestId, confirmedRecordId: record.id, confirmedAtTs: clock.value, updatedAtTs: clock.value,
        } });
        await requireChangelogWrite(defaultChangelogFactory(tx).recordChange({
          teacherId: input.teacherId, module: 'student-records', action: 'create', targetType: 'StudentRecord', targetId: record.id,
          before: null, after: { category: record.category, reviewStatus: record.reviewStatus, sourceRecordId: source.id, studentId: record.studentId, visibility: record.visibility }, source: 'manual',
        }));
        return ok(view(candidate, record, input.scheduleId ?? null, false));
      });
    } catch (caught) {
      if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') return err(versionConflict());
      throw caught;
    }
  };
}
function view(candidate: { id: string; eventId: string }, record: { id: string; studentId: string; category: string; visibility: string }, scheduleId: string | null, replayed: boolean): ConfirmedCaptureRecordView {
  return { eventId: candidate.eventId, candidateId: candidate.id, recordId: record.id, studentId: record.studentId, scheduleId, category: record.category === 'lesson_observation' ? 'lesson_observation' : 'general_note', visibility: record.visibility === 'parent_shareable' ? 'parent_shareable' : 'internal_only', replayed };
}
