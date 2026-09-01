import { parseRfc3339Instant } from './rfc3339-instant.js';
import type { EvidenceType, FeedbackEvidenceSnapshotInput } from './types.js';

const VALID_EVIDENCE_TYPES: ReadonlySet<string> = new Set(['assessment', 'record', 'lesson']);

function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === 'string' && VALID_EVIDENCE_TYPES.has(value);
}

export function validateEvidenceArray(
  evidence: unknown,
): { ok: true; value: FeedbackEvidenceSnapshotInput[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(evidence)) {
    return { ok: false, field: 'evidence', message: 'evidence 必须是数组' };
  }
  if (evidence.length > 100) {
    return { ok: false, field: 'evidence', message: 'evidence 条目过多' };
  }
  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i] as Record<string, unknown>;
    const prefix = `evidence[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, field: prefix, message: `${prefix} 必须是对象` };
    }
    if (!isEvidenceType(item.type)) {
      return { ok: false, field: `${prefix}.type`, message: `${prefix}.type 必须是 assessment/record/lesson` };
    }
    if (parseRfc3339Instant(item.occurredAt) === undefined) {
      return { ok: false, field: `${prefix}.occurredAt`, message: `${prefix}.occurredAt 必须是带时区的严格 RFC3339 时间` };
    }
    if (item.id !== undefined && item.id !== null && typeof item.id !== 'string') {
      return { ok: false, field: `${prefix}.id`, message: `${prefix}.id 必须是字符串` };
    }
    if (item.category !== undefined && item.category !== null && typeof item.category !== 'string') {
      return { ok: false, field: `${prefix}.category`, message: `${prefix}.category 必须是字符串` };
    }
    if (item.summary !== undefined && item.summary !== null && typeof item.summary !== 'string') {
      return { ok: false, field: `${prefix}.summary`, message: `${prefix}.summary 必须是字符串` };
    }
    if (item.examName !== undefined && item.examName !== null && typeof item.examName !== 'string') {
      return { ok: false, field: `${prefix}.examName`, message: `${prefix}.examName 必须是字符串` };
    }
    if (item.subject !== undefined && item.subject !== null && typeof item.subject !== 'string') {
      return { ok: false, field: `${prefix}.subject`, message: `${prefix}.subject 必须是字符串` };
    }
    if (item.score !== undefined && item.score !== null && typeof item.score !== 'number') {
      return { ok: false, field: `${prefix}.score`, message: `${prefix}.score 必须是数字` };
    }
    if (item.fullScore !== undefined && item.fullScore !== null && typeof item.fullScore !== 'number') {
      return { ok: false, field: `${prefix}.fullScore`, message: `${prefix}.fullScore 必须是数字` };
    }
    if (item.previousScore !== undefined && item.previousScore !== null && typeof item.previousScore !== 'number') {
      return { ok: false, field: `${prefix}.previousScore`, message: `${prefix}.previousScore 必须是数字` };
    }
    if (item.parentConcerns !== undefined && item.parentConcerns !== null) {
      if (!Array.isArray(item.parentConcerns) || item.parentConcerns.some((value) => typeof value !== 'string')) {
        return { ok: false, field: `${prefix}.parentConcerns`, message: `${prefix}.parentConcerns 必须是字符串数组` };
      }
    }
    if (item.followUps !== undefined && item.followUps !== null) {
      if (!Array.isArray(item.followUps) || item.followUps.some((value) => typeof value !== 'string')) {
        return { ok: false, field: `${prefix}.followUps`, message: `${prefix}.followUps 必须是字符串数组` };
      }
    }
  }
  return { ok: true, value: evidence as FeedbackEvidenceSnapshotInput[] };
}
