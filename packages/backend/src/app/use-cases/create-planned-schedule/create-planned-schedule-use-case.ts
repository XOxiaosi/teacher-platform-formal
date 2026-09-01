import { err, validationError } from '@teacher-platform/contracts';
import type { Confidence, ScheduleType } from '../../../features/scheduling/types.js';
import type { CreatePlannedScheduleDependencies, CreatePlannedScheduleUseCase } from './types.js';

type InstantParseResult =
  | { ok: true; value: Date }
  | { ok: false; reason: 'format' | 'timezone' };

function isScheduleType(value: unknown): value is ScheduleType {
  return value === 'lesson' || value === 'prep' || value === 'meeting' || value === 'call' || value === 'other';
}

function isConfidence(value: unknown): value is Confidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function parseRfc3339Instant(value: unknown): InstantParseResult {
  if (typeof value !== 'string') return { ok: false, reason: 'format' };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'format' };
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return { ok: false, reason: 'timezone' };
  return { ok: true, value: parsed };
}

function instantError(field: 'scheduledStart' | 'scheduledEnd', reason: 'format' | 'timezone') {
  const message = reason === 'timezone'
    ? `${field} 必须包含时区（Z 或 ±HH:MM）`
    : `${field} 格式无效`;
  return err(validationError(message, field));
}

export function createPlannedScheduleUseCase(
  deps: CreatePlannedScheduleDependencies,
): CreatePlannedScheduleUseCase {
  return {
    async create(input) {
      if (typeof input.title !== 'string' || !input.title.trim()) {
        return err(validationError('日程标题不能为空', 'title'));
      }
      if (!isScheduleType(input.type)) {
        return err(validationError('日程类型不合法', 'type'));
      }

      const scheduledStart = parseRfc3339Instant(input.scheduledStart);
      if (!scheduledStart.ok) return instantError('scheduledStart', scheduledStart.reason);
      const scheduledEnd = parseRfc3339Instant(input.scheduledEnd);
      if (!scheduledEnd.ok) return instantError('scheduledEnd', scheduledEnd.reason);
      if (scheduledEnd.value <= scheduledStart.value) {
        return err(validationError('结束时间必须晚于开始时间', 'scheduledEnd'));
      }
      if (input.confidence !== undefined && input.confidence !== null && !isConfidence(input.confidence)) {
        return err(validationError('confidence 必须是 high/medium/low', 'confidence'));
      }

      const trustedNow = await deps.trustedClock.now();
      if (!trustedNow.ok) return trustedNow;
      if (scheduledStart.value <= trustedNow.value) {
        return err(validationError('计划日程不能创建在过去', 'scheduledStart'));
      }

      return deps.scheduling.createSchedule({
        teacherId: input.teacherId,
        studentId: typeof input.studentId === 'string' ? input.studentId : undefined,
        type: input.type,
        title: input.title,
        scheduledStart: scheduledStart.value,
        scheduledEnd: scheduledEnd.value,
        confidence: isConfidence(input.confidence) ? input.confidence : undefined,
        pendingFields: Array.isArray(input.pendingFields)
          ? input.pendingFields.filter((item): item is string => typeof item === 'string')
          : undefined,
        sourceInput: typeof input.sourceInput === 'string' ? input.sourceInput : undefined,
      });
    },
  };
}
