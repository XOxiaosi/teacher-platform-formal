import type { Prisma } from '@prisma/client';
import { decryptFieldValue, type FieldCipher } from '../../shared/field-encryption/index.js';
import type { FeedbackStatus, ParentFeedbackData } from './types.js';

export interface ParentFeedbackRecord {
  id: string;
  teacherId: string;
  studentId: string;
  lessonId: string | null;
  title: string;
  content: string;
  status: string;
  channel: string | null;
  parentName: string | null;
  sentAtTs: Date | null;
  moderationFlagged: boolean | null;
  moderationReasons: Prisma.JsonValue | null;
  createdAtTs: Date;
  updatedAtTs: Date;
}

export function toFeedbackStatus(value: string): FeedbackStatus {
  if (value === 'draft' || value === 'reviewed' || value === 'sent' || value === 'archived') return value;
  return 'draft';
}

export function toParentFeedbackData(
  record: ParentFeedbackRecord,
  cipher: FieldCipher | undefined,
): ParentFeedbackData {
  return {
    id: record.id,
    teacherId: record.teacherId,
    studentId: record.studentId,
    lessonId: record.lessonId,
    title: decryptFieldValue(cipher, record.title),
    content: decryptFieldValue(cipher, record.content),
    status: toFeedbackStatus(record.status),
    channel: record.channel,
    parentName: record.parentName === null ? null : decryptFieldValue(cipher, record.parentName),
    sentAt: record.sentAtTs,
    moderationFlagged: record.moderationFlagged,
    moderationReasons: Array.isArray(record.moderationReasons)
      ? record.moderationReasons.filter((reason): reason is string => typeof reason === 'string')
      : null,
    createdAt: record.createdAtTs,
    updatedAt: record.updatedAtTs,
  };
}
