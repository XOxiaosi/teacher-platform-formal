import { err, ok, validationError, type CommonError, type Result } from '@teacher-platform/contracts';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const BUSINESS_OFFSET = '+08:00';
const BUSINESS_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarInput {
  now: Date;
  timeZone: 'Asia/Shanghai';
}

export interface TodayWindow {
  businessDate: string;
  windowStart: Date;
  windowEndExclusive: Date;
}

export interface WeekWindow {
  weekStart: string;
  weekEndExclusive: string;
  days: string[];
  windowStart: Date;
  windowEndExclusive: Date;
}

function validDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validTimeZone(value: unknown): value is 'Asia/Shanghai' {
  return value === BUSINESS_TIME_ZONE;
}

function dateParts(value: Date, timeZone: 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((item) => item.type === type)?.value ?? ''
  );
  return { year: part('year'), month: part('month'), day: part('day') };
}

function businessDateFor(value: Date, timeZone: 'Asia/Shanghai'): string {
  const parts = dateParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseBusinessDate(value: string): { year: number; month: number; day: number } | null {
  const match = BUSINESS_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function addBusinessDays(value: string, amount: number): string {
  const parsed = parseBusinessDate(value);
  if (!parsed) throw new Error('invalid business date');
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + amount));
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function businessDateInstant(value: string): Date {
  return new Date(`${value}T00:00:00${BUSINESS_OFFSET}`);
}

function weekday(value: string): number {
  const parsed = parseBusinessDate(value);
  if (!parsed) return Number.NaN;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

function validateCalendarInput(input: CalendarInput): CommonError | null {
  if (!validDate(input.now)) return validationError('可信时间无效', 'now');
  if (!validTimeZone(input.timeZone)) return validationError('业务时区不合法', 'timeZone');
  return null;
}

export function getTodayWindow(input: CalendarInput): Result<TodayWindow, CommonError> {
  const inputError = validateCalendarInput(input);
  if (inputError) return err(inputError);
  const businessDate = businessDateFor(input.now, input.timeZone);
  return ok({
    businessDate,
    windowStart: businessDateInstant(businessDate),
    windowEndExclusive: businessDateInstant(addBusinessDays(businessDate, 1)),
  });
}

export function getWeekWindow(
  input: CalendarInput & { weekStart?: string },
): Result<WeekWindow, CommonError> {
  const inputError = validateCalendarInput(input);
  if (inputError) return err(inputError);

  let weekStart = input.weekStart;
  if (weekStart !== undefined) {
    if (!parseBusinessDate(weekStart) || weekday(weekStart) !== 1) {
      return err(validationError('weekStart 必须是合法的周一日期', 'weekStart'));
    }
  } else {
    const today = businessDateFor(input.now, input.timeZone);
    const daysSinceMonday = (weekday(today) + 6) % 7;
    weekStart = addBusinessDays(today, -daysSinceMonday);
  }

  const days = Array.from({ length: 7 }, (_, index) => addBusinessDays(weekStart, index));
  const weekEndExclusive = addBusinessDays(weekStart, 7);
  return ok({
    weekStart,
    weekEndExclusive,
    days,
    windowStart: businessDateInstant(weekStart),
    windowEndExclusive: businessDateInstant(weekEndExclusive),
  });
}

export function getOverlappingBusinessDates(input: {
  startAt: Date;
  endAt: Date;
  days: readonly string[];
  timeZone: 'Asia/Shanghai';
}): string[] {
  if (
    !validDate(input.startAt)
    || !validDate(input.endAt)
    || input.endAt <= input.startAt
    || !validTimeZone(input.timeZone)
  ) return [];

  return input.days.filter((date) => {
    if (!parseBusinessDate(date)) return false;
    const dayStart = businessDateInstant(date);
    const dayEndExclusive = businessDateInstant(addBusinessDays(date, 1));
    return input.startAt < dayEndExclusive && input.endAt > dayStart;
  });
}
