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

function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
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
      const formalLesson = input.type === 'lesson';
      if (formalLesson && input.title !== undefined) {
        return err(validationError('课程排期不接受课程名称', 'title'));
      }
      if (input.clientRequestId !== undefined && !isClientRequestId(input.clientRequestId)) {
        return err(validationError('clientRequestId 格式不合法', 'clientRequestId'));
      }
      if (input.participantIds !== undefined && (
        !Array.isArray(input.participantIds)
        || input.participantIds.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim())
      )) {
        return err(validationError('participantIds 必须是非空字符串数组', 'participantIds'));
      }
      const participantIds = input.participantIds as string[] | undefined;
      if (participantIds && new Set(participantIds).size !== participantIds.length) {
        return err(validationError('participantIds 不能包含重复学生', 'participantIds'));
      }
      if (input.location !== undefined && typeof input.location !== 'string') {
        return err(validationError('课程地点格式不合法', 'location'));
      }
      if (input.classFormat !== undefined && input.classFormat !== 'one_to_one' && input.classFormat !== 'small_group') {
        return err(validationError('课程形式不合法', 'classFormat'));
      }
      if (input.operationalNote !== undefined && typeof input.operationalNote !== 'string') {
        return err(validationError('课程备注格式不合法', 'operationalNote'));
      }
      if (formalLesson) {
        if (!isClientRequestId(input.clientRequestId)) return err(validationError('课程必须提供 clientRequestId', 'clientRequestId'));
        if (input.studentId !== undefined) return err(validationError('正式课程请使用 participantIds', 'studentId'));
        if (typeof input.location !== 'string' || !input.location.trim()) return err(validationError('课程地点不能为空', 'location'));
        if (input.classFormat !== 'one_to_one' && input.classFormat !== 'small_group') return err(validationError('课程形式不合法', 'classFormat'));
        if (!participantIds || participantIds.length === 0) return err(validationError('课程必须选择参与人', 'participantIds'));
        if (input.classFormat === 'one_to_one' && participantIds.length !== 1) {
          return err(validationError('一对一课程必须且只能有一名参与人', 'participantIds'));
        }
        if (input.classFormat === 'small_group' && participantIds.length < 2) {
          return err(validationError('小班课程至少需要两名参与人', 'participantIds'));
        }
      } else {
        if (input.participantIds !== undefined || input.location !== undefined
          || input.classFormat !== undefined || input.operationalNote !== undefined) {
          return err(validationError('结构化课程字段只适用于 lesson', 'type'));
        }
        if (typeof input.title !== 'string' || !input.title.trim()) {
          return err(validationError('日程标题不能为空', 'title'));
        }
      }

      const trustedNow = await deps.trustedClock.now();
      if (!trustedNow.ok) return trustedNow;
      if (scheduledStart.value <= trustedNow.value) {
        return err(validationError('计划日程不能创建在过去', 'scheduledStart'));
      }

      return deps.scheduling.createSchedule({
        teacherId: input.teacherId,
        clientRequestId: isClientRequestId(input.clientRequestId) ? input.clientRequestId : undefined,
        studentId: typeof input.studentId === 'string' ? input.studentId : undefined,
        participantIds,
        type: input.type,
        title: typeof input.title === 'string' ? input.title : undefined,
        location: typeof input.location === 'string' ? input.location : undefined,
        classFormat: input.classFormat === 'one_to_one' || input.classFormat === 'small_group' ? input.classFormat : undefined,
        operationalNote: typeof input.operationalNote === 'string' ? input.operationalNote : undefined,
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
