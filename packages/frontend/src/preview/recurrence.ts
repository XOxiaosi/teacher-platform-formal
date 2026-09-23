import type { DemoData, RecurrenceRule, Schedule } from './data';
import { formatDate } from '../shared/date-format';

const dayMs = 86_400_000;

function utcDay(iso: string) { return new Date(`${iso}T12:00:00Z`); }
function iso(date: Date) { return date.toISOString().slice(0, 10); }

/** Adds calendar days without depending on the viewer's local time zone. */
export function dateAdd(value: string, days: number): string {
  return iso(new Date(utcDay(value).getTime() + days * dayMs));
}

export function isoWeekday(value: string) {
  const sundayZero = utcDay(value).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

/**
 * Moving one recurrence occurrence changes that occurrence's weekday in the
 * replacement rule, while preserving every other weekly slot. The source slot
 * is deliberately removed so a drag from Monday to Wednesday does not create
 * both a new Wednesday lesson and a continuing Monday lesson.
 */
export function movedOccurrenceWeekdays(days: number[], sourceDay: string, targetDay: string) {
  if (sourceDay === targetDay) return [...days];
  const sourceWeekday = isoWeekday(sourceDay);
  const targetWeekday = isoWeekday(targetDay);
  return [...new Set(days.filter((day) => day !== sourceWeekday).concat(targetWeekday))].sort((a, b) => a - b);
}

export function occursOn(rule: RecurrenceRule, day: string) {
  return rule.enabled && day >= rule.startDate && (!rule.endDate || day <= rule.endDate) && rule.weekdays.includes(isoWeekday(day));
}

function exceptionFor(data: DemoData, ruleId: string, day: string) {
  return data.schedules.find((item) => item.recurrenceRuleId === ruleId && item.recurrenceDay === day);
}

export function scheduleFromRule(rule: RecurrenceRule, day: string): Schedule {
  return {
    id: `${rule.id}@${day}`, day, start: rule.start, end: rule.end, location: rule.location,
    participants: [...rule.participants], format: rule.format, note: rule.note, status: '已排期',
    recurrenceRuleId: rule.id, recurrenceDay: day,
    ...(rule.version ? { version: rule.version, updatedAt: rule.updatedAt } : {}),
  };
}

/**
 * Projects rules only for the requested range. There is deliberately no fixed
 * week limit: a far-future weekly rule remains visible when that week is opened.
 */
export function schedulesInRange(data: DemoData, from: string, to: string): Schedule[] {
  const direct = data.schedules.filter((item) => item.day >= from && item.day <= to);
  const projected: Schedule[] = [];
  for (const rule of data.recurrenceRules) {
    const start = rule.startDate > from ? rule.startDate : from;
    const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
    for (let day = start; day <= end; day = dateAdd(day, 1)) {
      if (occursOn(rule, day) && !exceptionFor(data, rule.id, day)) projected.push(scheduleFromRule(rule, day));
    }
  }
  return [...direct, ...projected].sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function overlapsTime(a: Pick<Schedule, 'start' | 'end'>, b: Pick<Schedule, 'start' | 'end'>) {
  return a.start < b.end && a.end > b.start;
}

export function scheduleConflict(items: Schedule[], candidate: Schedule) {
  return items.some((item) => item.id !== candidate.id && item.status !== '已取消' && item.day === candidate.day && overlapsTime(item, candidate));
}

function firstWeekdayOnOrAfter(start: string, weekday: number) {
  return dateAdd(start, (weekday - isoWeekday(start) + 7) % 7);
}

function rulesIntersect(data: DemoData, a: RecurrenceRule, b: RecurrenceRule) {
  const first = a.startDate > b.startDate ? a.startDate : b.startDate;
  const last = !a.endDate ? b.endDate : !b.endDate ? a.endDate : a.endDate < b.endDate ? a.endDate : b.endDate;
  const matchingDays = a.weekdays.filter((weekday) => b.weekdays.includes(weekday));
  return matchingDays.some((weekday) => {
    // Any materialized exception replaces its original slot, not just cancellations.
    // At most the finite number of exceptions can be skipped before a real overlap.
    for (let day = firstWeekdayOnOrAfter(first, weekday); !last || day <= last; day = dateAdd(day, 7)) {
      if (!exceptionFor(data, a.id, day) && !exceptionFor(data, b.id, day)) return true;
    }
    return false;
  });
}

/** Checks all future intersections mathematically, including unbounded rules. */
export function recurrenceConflict(data: DemoData, candidate: RecurrenceRule, ignoreRuleId?: string) {
  if (!candidate.enabled) return false;
  const otherRules = data.recurrenceRules.filter((rule) => rule.id !== candidate.id && rule.id !== ignoreRuleId && rule.enabled);
  if (otherRules.some((rule) => overlapsTime(rule, candidate) && rulesIntersect(data, rule, candidate))) return true;
  const direct = data.schedules.filter((item) => item.status !== '已取消');
  // Base rule against concrete occurrences, including exceptions moved into another slot.
  if (direct.some((item) => overlapsTime(item, candidate) && occursOn(candidate, item.day)
    && !exceptionFor(data, candidate.id, item.day))) return true;
  // Candidate exceptions keep their own date/time and must also be checked as such.
  return direct.filter((item) => item.recurrenceRuleId === candidate.id).some((item) =>
    otherRules.some((rule) => occursOn(rule, item.day) && !exceptionFor(data, rule.id, item.day) && overlapsTime(rule, item))
    || direct.some((other) => other.id !== item.id && other.day === item.day && overlapsTime(other, item)));
}

export function ruleFor(data: DemoData, schedule: Schedule) {
  return schedule.recurrenceRuleId ? data.recurrenceRules.find((rule) => rule.id === schedule.recurrenceRuleId) : undefined;
}

export function scheduleObjectLabel(data: DemoData, item: Schedule) {
  if (item.format === '小班') return `小班 · ${item.participants.length} 人`;
  const name = data.students.find((student) => student.id === item.participants[0])?.name || '待补充参与人';
  return name;
}

export function changeSummary(before: Schedule, after: Schedule, scope: 'this' | 'future') {
  const format = (item: Schedule) => `${formatDate(item.day)} ${item.start}–${item.end} · ${item.location} · ${item.format}`;
  return { before: format(before), after: format(after), scope: scope === 'this' ? '仅本次' : '本次及以后' };
}

/** The selected instance may itself be an exception whose visible day moved. */
export function recurrenceSplitBoundary(before: Schedule, after: Schedule) {
  const originalSlot = before.recurrenceDay || before.day;
  return { previousRuleEnds: dateAdd(originalSlot, -1), replacementStarts: after.day };
}
