import { decryptFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import type { CreateScheduleInput, ScheduleData } from './types.js';

export const scheduleInclude = { participants: { orderBy: { createdAtTs: 'asc' } } } as const;

export function toScheduleData(record: any, cipher?: FieldCipher): ScheduleData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    participantIds: Array.isArray(record.participants)
      ? record.participants.map((participant: { studentId: string }) => participant.studentId)
      : (record.studentId ? [record.studentId] : []),
    type: record.type,
    title: record.title,
    location: decryptOptional(cipher, record.locationCiphertext),
    classFormat: record.classFormat === 'one_to_one' || record.classFormat === 'small_group'
      ? record.classFormat
      : null,
    operationalNote: decryptOptional(cipher, record.operationalNoteCiphertext),
    scheduledStart: record.scheduledStartTs,
    scheduledEnd: record.scheduledEndTs,
    status: record.status,
    confidence: record.confidence,
    pendingFields: record.pendingFields,
    sourceInput: record.sourceInput,
    parentId: record.parentId,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}

export function sameScheduleRequest(record: any, input: CreateScheduleInput, cipher: FieldCipher | undefined): boolean {
  return record.type === input.type
    && record.scheduledStartTs.getTime() === input.scheduledStart.getTime()
    && record.scheduledEndTs.getTime() === input.scheduledEnd.getTime()
    && record.classFormat === (input.classFormat ?? null)
    && decryptOptional(cipher, record.locationCiphertext) === (input.location?.trim() || null)
    && decryptOptional(cipher, record.operationalNoteCiphertext) === (input.operationalNote?.trim() || null)
    && sameIds(record.participants.map((item: { studentId: string }) => item.studentId), input.participantIds ?? (input.studentId ? [input.studentId] : []));
}

function decryptOptional(cipher: FieldCipher | undefined, value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : decryptFieldValue(cipher, value);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
