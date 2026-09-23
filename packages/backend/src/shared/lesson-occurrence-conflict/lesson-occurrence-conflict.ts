import type { Prisma, PrismaClient } from '@prisma/client';

type ConflictClient = PrismaClient | Prisma.TransactionClient;

export interface LessonOccurrenceConflictOptions {
  ignoreScheduleId?: string;
  ignoreRuleOccurrence?: { ruleId: string; day: string };
}

const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Checks a concrete lesson window against both stored schedules and enabled,
 * not-yet-materialized weekly rules. A materialized rule occurrence is an
 * explicit exception, so the rule itself no longer occupies that original
 * slot; the concrete Schedule row is checked separately at its actual time.
 *
 * The query only relies on the shared Schedule and RecurrenceRule persistence
 * contract, so both formal scheduling and the scheduling web feature use this
 * single conflict definition without introducing a feature-to-feature import.
 */
export async function hasLessonOccurrenceConflict(
  prisma: ConflictClient,
  teacherId: string,
  window: { start: Date; end: Date },
  options: LessonOccurrenceConflictOptions = {},
): Promise<boolean> {
  const direct = await prisma.schedule.findFirst({
    where: {
      teacherId,
      type: 'lesson',
      status: { in: ['planned', 'extra'] },
      scheduledStartTs: { lt: window.end },
      scheduledEndTs: { gt: window.start },
      ...(options.ignoreScheduleId ? { id: { not: options.ignoreScheduleId } } : {}),
    },
    select: { id: true },
  });
  if (direct) return true;

  // The end is exclusive. Subtract one millisecond so a window ending at
  // Beijing midnight does not inspect the following calendar day.
  const startDay = localDay(window.start);
  const endDay = localDay(new Date(window.end.getTime() - 1));
  const rules = await prisma.recurrenceRule.findMany({
    where: {
      teacherId,
      enabled: true,
      startDate: { lte: dateOnly(endDay) },
      OR: [{ endDate: null }, { endDate: { gte: dateOnly(startDay) } }],
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      weekdays: true,
      startTime: true,
      endTime: true,
    },
  });
  if (rules.length === 0) return false;

  const exceptions = await prisma.schedule.findMany({
    where: {
      teacherId,
      recurrenceRuleId: { in: rules.map((rule) => rule.id) },
      recurrenceDay: { gte: dateOnly(startDay), lte: dateOnly(endDay) },
    },
    select: { recurrenceRuleId: true, recurrenceDay: true },
  });
  const exceptionKeys = new Set(exceptions.flatMap((row) => (
    row.recurrenceRuleId && row.recurrenceDay
      ? [`${row.recurrenceRuleId}:${dateDay(row.recurrenceDay)}`]
      : []
  )));

  for (const rule of rules) {
    const firstDay = maxDay(startDay, dateDay(rule.startDate));
    const lastDay = minDay(endDay, rule.endDate ? dateDay(rule.endDate) : endDay);
    if (firstDay > lastDay) continue;
    const weekdays = Array.isArray(rule.weekdays)
      ? [...new Set(rule.weekdays.filter((day): day is number => (
        typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7
      )))]
      : [];
    for (const wantedWeekday of weekdays) {
      let day = firstWeekdayOnOrAfter(firstDay, wantedWeekday);
      while (day <= lastDay) {
        const ignored = options.ignoreRuleOccurrence?.ruleId === rule.id
          && options.ignoreRuleOccurrence.day === day;
        const exception = exceptionKeys.has(`${rule.id}:${day}`);
        if (!ignored && !exception) {
          const start = instant(day, rule.startTime);
          const end = instant(day, rule.endTime);
          if (start < window.end && end > window.start) return true;
        }
        day = addDays(day, 7);
      }
    }
  }
  return false;
}

function localDay(date: Date): string {
  const values = Object.fromEntries(
    shanghai.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function dateDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOnly(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function instant(day: string, time: string): Date {
  return new Date(`${day}T${time}:00+08:00`);
}

function weekday(day: string): number {
  const value = dateOnly(day).getUTCDay();
  return value === 0 ? 7 : value;
}

function firstWeekdayOnOrAfter(day: string, wanted: number): string {
  return addDays(day, (wanted - weekday(day) + 7) % 7);
}

function addDays(day: string, amount: number): string {
  const value = dateOnly(day);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function maxDay(left: string, right: string): string {
  return left > right ? left : right;
}

function minDay(left: string, right: string): string {
  return left < right ? left : right;
}
