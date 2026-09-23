import type { Prisma, PrismaClient } from '@prisma/client';
import type { WebRuleInput } from './scheduling-web-service.js';

type Db = PrismaClient | Prisma.TransactionClient;

const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit' });

/**
 * Checks a replacement against the post-switch projection: materialized rows
 * suppress their virtual rule occurrence, while active rows keep competing at
 * their actual date/time. The old rule is excluded because it is cut at O.
 */
export async function replacementHasConflict(prisma: Db, teacherId: string, oldRuleId: string, fromDate: string, replacement: WebRuleInput, anchorId?: string): Promise<boolean> {
  const [rules, schedules, materializations] = await Promise.all([
    prisma.recurrenceRule.findMany({ where: { teacherId, enabled: true, id: { not: oldRuleId } } }),
    prisma.schedule.findMany({ where: { teacherId, type: 'lesson', status: { in: ['planned', 'extra'] } }, select: { id: true, recurrenceRuleId: true, recurrenceDay: true, scheduledStartTs: true, scheduledEndTs: true } }),
    prisma.schedule.findMany({ where: { teacherId, recurrenceRuleId: { not: null }, recurrenceDay: { not: null } }, select: { id: true, recurrenceRuleId: true, recurrenceDay: true } }),
  ]);
  const exceptionKeys = new Set(materializations.flatMap((row) => row.recurrenceRuleId && row.recurrenceDay ? [`${row.recurrenceRuleId}:${localDay(row.recurrenceDay)}`] : []));
  const replacementExceptionDays = new Set(materializations.flatMap((row) => {
    if (row.recurrenceRuleId !== oldRuleId || !row.recurrenceDay || localDay(row.recurrenceDay) < fromDate) return [];
    return [row.id === anchorId ? replacement.startDate : localDay(row.recurrenceDay)];
  }));
  const targetDay = replacement.startDate;
  if (anchorId || (replacement.enabled !== false && occurs(replacement, targetDay))) {
    if (schedules.some((row) => row.id !== anchorId && localDay(row.scheduledStartTs) === targetDay && overlaps(replacement.start, replacement.end, localTime(row.scheduledStartTs), localTime(row.scheduledEndTs)))) return true;
    if (rules.some((row) => occurs(row, targetDay) && !exceptionKeys.has(`${row.id}:${targetDay}`) && overlaps(replacement.start, replacement.end, row.startTime, row.endTime))) return true;
  }
  if (replacement.enabled === false) return false;
  if (rules.some((row) => overlaps(replacement.start, replacement.end, row.startTime, row.endTime) && ruleOverlapWithoutMaterializedExceptions(replacement, row, replacementExceptionDays, exceptionKeys))) return true;
  return schedules.some((row) => {
    if (row.id === anchorId) return false;
    const actualDay = localDay(row.scheduledStartTs);
    const recurrenceDay = row.recurrenceDay ? localDay(row.recurrenceDay) : undefined;
    const transferredSameDayException = row.recurrenceRuleId === oldRuleId && recurrenceDay !== undefined && recurrenceDay >= fromDate && recurrenceDay === actualDay;
    return !transferredSameDayException && occurs(replacement, actualDay) && overlaps(replacement.start, replacement.end, localTime(row.scheduledStartTs), localTime(row.scheduledEndTs));
  });
}

function ruleOverlapWithoutMaterializedExceptions(candidate: WebRuleInput, existing: any, candidateExceptionDays: Set<string>, exceptionKeys: Set<string>) {
  const existingStart = localDay(existing.startDate); const existingEnd = existing.endDate ? localDay(existing.endDate) : undefined;
  const first = candidate.startDate > existingStart ? candidate.startDate : existingStart;
  const last = !candidate.endDate ? existingEnd : !existingEnd ? candidate.endDate : candidate.endDate < existingEnd ? candidate.endDate : existingEnd;
  if (last && last < first) return false;
  const theirs = Array.isArray(existing.weekdays) ? existing.weekdays : [];
  for (const dayOfWeek of unique(candidate.weekdays).filter((day) => theirs.includes(day))) {
    for (let day = addDays(first, (dayOfWeek - weekday(first) + 7) % 7); !last || day <= last; day = addDays(day, 7)) {
      if (!candidateExceptionDays.has(day) && !exceptionKeys.has(`${existing.id}:${day}`)) return true;
    }
  }
  return false;
}

function unique<T>(values: readonly T[]) { return [...new Set(values)]; }
function addDays(day: string, amount: number) { const value = new Date(`${day}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); }
function weekday(day: string) { const value = new Date(`${day}T00:00:00.000Z`).getUTCDay(); return value === 0 ? 7 : value; }
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) { return aStart < bEnd && aEnd > bStart; }
function parts(date: Date) { return Object.fromEntries(shanghai.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])); }
function localDay(date: Date) { const p = parts(date); return `${p.year}-${p.month}-${p.day}`; }
function localTime(date: Date) { const p = parts(date); return `${p.hour}:${p.minute}`; }
function ruleDay(value: string | Date) { return typeof value === 'string' ? value : localDay(value); }
function occurs(rule: { enabled?: boolean; startDate: string | Date; endDate?: string | Date | null; weekdays: unknown }, day: string) { const days = Array.isArray(rule.weekdays) ? rule.weekdays : []; return rule.enabled !== false && day >= ruleDay(rule.startDate) && (!rule.endDate || day <= ruleDay(rule.endDate)) && days.includes(weekday(day)); }
