import { Router, type Router as ExpressRouter } from 'express';
import { validationError } from '@teacher-platform/contracts';
import type { StudentTimelineService, TimelineEntryType } from '../../features/student-timeline/index.js';
import { getTeacherId, parseNumber, sendResult, sendTeacherError } from './api-helpers.js';

const TIMELINE_TYPES: ReadonlySet<TimelineEntryType> = new Set(['record', 'assessment', 'lesson', 'feedback']);
const TIMELINE_CATEGORIES = new Set([
  'assessment', 'lesson_observation', 'parent_communication', 'learning_state', 'homework',
  'goal', 'achievement', 'concern', 'agreement', 'follow_up', 'general_note',
]);

export function createStudentTimelineRouter(timeline: StudentTimelineService): Router {
  const router = Router();
  registerStudentTimelineRoutes(router, timeline);
  return router;
}

export function registerStudentTimelineRoutes(router: ExpressRouter, timeline: StudentTimelineService): void {
  router.get('/students/:studentId/timeline', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    const parsed = parseTimelineQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) return sendTeacherError(res, parsed.error);
    const result = await timeline.getStudentTimeline({ teacherId: teacher.value, studentId: req.params.studentId, ...parsed.value });
    sendResult(res, result);
  });

  router.get('/students/:studentId/timeline/:entryType/:entryId/detail', async (req, res) => {
    const teacher = getTeacherId(req);
    if (!teacher.ok) return sendTeacherError(res, teacher.error);
    if (!TIMELINE_TYPES.has(req.params.entryType as TimelineEntryType)) {
      return sendTeacherError(res, validationError('entryType 不合法', 'entryType'));
    }
    const result = await timeline.getStudentTimelineDetail({
      teacherId: teacher.value,
      studentId: req.params.studentId,
      entryType: req.params.entryType as TimelineEntryType,
      entryId: req.params.entryId,
    });
    sendResult(res, result);
  });
}

function queryValues(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) return undefined;
  return values.flatMap((item) => item.split(',')).map((item) => item.trim()).filter(Boolean);
}

function parseStrictInstant(value: unknown, field: 'from' | 'to') {
  if (value === undefined) return { ok: true as const, value: undefined };
  const text = typeof value === 'string' ? value : '';
  const match = text
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(text)
    : null;
  if (!match) return { ok: false as const, error: validationError(`${field} 必须是带时区的 RFC3339 时间`, field) };
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const invalidCalendar = month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59;
  const invalidOffset = offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59);
  if (invalidCalendar || invalidOffset) return { ok: false as const, error: validationError(`${field} 必须是有效的 RFC3339 时间`, field) };
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? { ok: false as const, error: validationError(`${field} 必须是有效时间`, field) }
    : { ok: true as const, value: parsed };
}

function parseTimelineQuery(query: Record<string, unknown>) {
  const page = parseNumber(query.page);
  const pageSize = parseNumber(query.pageSize);
  const limit = parseNumber(query.limit);
  if (query.page !== undefined && (!Number.isSafeInteger(page) || page! < 1)) return { ok: false as const, error: validationError('page 必须是大于等于 1 的整数', 'page') };
  if (query.pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize! < 1 || pageSize! > 200)) return { ok: false as const, error: validationError('pageSize 必须在 1-200 之间', 'pageSize') };
  if (query.limit !== undefined && (!Number.isSafeInteger(limit) || limit! < 1 || limit! > 200)) return { ok: false as const, error: validationError('limit 必须在 1-200 之间', 'limit') };
  const from = parseStrictInstant(query.from, 'from');
  if (!from.ok) return from;
  const to = parseStrictInstant(query.to, 'to');
  if (!to.ok) return to;
  if (from.value && to.value && from.value.getTime() >= to.value.getTime()) return { ok: false as const, error: validationError('from 必须早于 to', 'from') };
  const types = queryValues(query.types);
  if (query.types !== undefined && (!types?.length || types.some((value) => !TIMELINE_TYPES.has(value as TimelineEntryType)))) return { ok: false as const, error: validationError('types 包含不合法类型', 'types') };
  const categories = queryValues(query.categories);
  if (query.categories !== undefined && (!categories?.length || categories.some((value) => !TIMELINE_CATEGORIES.has(value)))) return { ok: false as const, error: validationError('categories 包含不合法类别', 'categories') };
  return { ok: true as const, value: { page, pageSize, limit, from: from.value, to: to.value, types: types as TimelineEntryType[] | undefined, categories } };
}
