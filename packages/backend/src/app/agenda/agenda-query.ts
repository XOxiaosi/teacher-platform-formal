import {
  err,
  internalError,
  ok,
  validationError,
  type CommonError,
} from '@teacher-platform/contracts';
import type { ScheduleData } from '../../features/scheduling/types.js';
import { projectAgendaToday, projectAgendaWeek } from './agenda-projection.js';
import { getTodayWindow, getWeekWindow } from './business-calendar.js';
import type { AgendaQueryDependencies, AgendaQueryPort } from './types.js';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_ID_LENGTH = 128;
const MAX_SOURCE_ITEMS = 500;

function validDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validMondayBusinessDate(value: string): boolean {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && parsed.getUTCDay() === 1;
}

function validateBaseInput(input: {
  teacherId: string;
  timeZone: 'Asia/Shanghai';
}): CommonError | null {
  if (
    typeof input.teacherId !== 'string'
    || input.teacherId.trim().length === 0
    || input.teacherId.length > MAX_ID_LENGTH
  ) return validationError('teacherId 无效', 'teacherId');
  if (input.timeZone !== BUSINESS_TIME_ZONE) {
    return validationError('业务时区不合法', 'timeZone');
  }
  return null;
}

function sourceOverflow(source: { items: readonly unknown[]; total: number }): boolean {
  return source.total > MAX_SOURCE_ITEMS || source.items.length > MAX_SOURCE_ITEMS;
}

function lessonStudentIds(schedules: readonly ScheduleData[]): string[] {
  const ids = schedules.flatMap((schedule) => (
    schedule.type === 'lesson'
      ? (schedule.participantIds.length > 0
        ? schedule.participantIds
        : (schedule.studentId ? [schedule.studentId] : []))
      : []
  ));
  return [...new Set(ids)].sort();
}

async function readSources(
  dependencies: AgendaQueryDependencies,
  input: {
    teacherId: string;
    now: Date;
    windowStart: Date;
    windowEndExclusive: Date;
    includeMemoLowerBound: boolean;
  },
) {
  const [schedules, memos, pendingActions] = await Promise.all([
    dependencies.schedules.listOverlappingSchedules({
      teacherId: input.teacherId,
      type: 'lesson',
      windowStart: input.windowStart,
      windowEndExclusive: input.windowEndExclusive,
    }),
    dependencies.memos.listAgendaMemos({
      teacherId: input.teacherId,
      ...(input.includeMemoLowerBound ? { dueAtFrom: input.windowStart } : {}),
      dueAtBefore: input.windowEndExclusive,
    }),
    dependencies.pendingActions.listActivePendingActions({
      teacherId: input.teacherId,
      activeAt: input.now,
    }),
  ]);
  if (!schedules.ok) return err(schedules.error);
  if (!memos.ok) return err(memos.error);
  if (!pendingActions.ok) return err(pendingActions.error);
  if (
    sourceOverflow(schedules.value)
    || sourceOverflow(memos.value)
    || sourceOverflow(pendingActions.value)
  ) {
    return err(internalError('Agenda source超过500项，拒绝返回截断结果'));
  }

  const studentIds = lessonStudentIds(schedules.value.items);
  if (studentIds.length === 0) {
    return ok({
      schedules: schedules.value.items,
      memos: memos.value.items,
      pendingActions: pendingActions.value.items,
      students: [],
    });
  }
  const students = await dependencies.students.listOwnedStudentsByIds({
    teacherId: input.teacherId,
    studentIds,
  });
  if (!students.ok) return err(students.error);
  return ok({
    schedules: schedules.value.items,
    memos: memos.value.items,
    pendingActions: pendingActions.value.items,
    students: students.value,
  });
}

export function createAgendaQuery(dependencies: AgendaQueryDependencies): AgendaQueryPort {
  return {
    async getToday(input) {
      const inputError = validateBaseInput(input);
      if (inputError) return err(inputError);

      const nowResult = await dependencies.trustedClock.now();
      if (!nowResult.ok) return err(nowResult.error);
      if (!validDate(nowResult.value)) {
        return err(internalError('TrustedClock返回无效时间'));
      }
      const window = getTodayWindow({ now: nowResult.value, timeZone: input.timeZone });
      if (!window.ok) return err(window.error);

      const sources = await readSources(dependencies, {
        teacherId: input.teacherId,
        now: nowResult.value,
        windowStart: window.value.windowStart,
        windowEndExclusive: window.value.windowEndExclusive,
        includeMemoLowerBound: false,
      });
      if (!sources.ok) return err(sources.error);
      return ok(projectAgendaToday({
        generatedAt: nowResult.value,
        timeZone: input.timeZone,
        businessDate: window.value.businessDate,
        ...sources.value,
      }));
    },

    async getWeek(input) {
      const inputError = validateBaseInput(input);
      if (inputError) return err(inputError);
      if (input.weekStart !== undefined && !validMondayBusinessDate(input.weekStart)) {
        return err(validationError('weekStart 必须是合法的周一日期', 'weekStart'));
      }

      const nowResult = await dependencies.trustedClock.now();
      if (!nowResult.ok) return err(nowResult.error);
      if (!validDate(nowResult.value)) {
        return err(internalError('TrustedClock返回无效时间'));
      }
      const window = getWeekWindow({
        now: nowResult.value,
        timeZone: input.timeZone,
        ...(input.weekStart ? { weekStart: input.weekStart } : {}),
      });
      if (!window.ok) return err(window.error);

      const sources = await readSources(dependencies, {
        teacherId: input.teacherId,
        now: nowResult.value,
        windowStart: window.value.windowStart,
        windowEndExclusive: window.value.windowEndExclusive,
        includeMemoLowerBound: true,
      });
      if (!sources.ok) return err(sources.error);
      return ok(projectAgendaWeek({
        generatedAt: nowResult.value,
        timeZone: input.timeZone,
        weekStart: window.value.weekStart,
        weekEndExclusive: window.value.weekEndExclusive,
        days: window.value.days,
        ...sources.value,
      }));
    },
  };
}
