import type { DemoData, RecurrenceRule, Schedule, ScheduleRevision } from './data';
import { dateAdd } from './recurrence';

export function completePlannedSchedule(data: DemoData, target: Schedule): DemoData {
  if (target.status !== '已排期' || data.schedules.some((item) => item.id === target.id && item.status !== '已排期')) return data;
  const records = target.participants.map((studentId) => {
    const before = data.students.find((student) => student.id === studentId)?.balance ?? 0;
    return { id: `cr-${target.id}-${studentId}`, scheduleId: target.id, studentId, date: target.day, before, after: before - 1 };
  });
  const completed = { ...target, status: '已完成' as const };
  return { ...data, students: data.students.map((student) => target.participants.includes(student.id) ? { ...student, balance: student.balance - 1 } : student), completionRecords: [...data.completionRecords, ...records], schedules: data.schedules.some((item) => item.id === target.id) ? data.schedules.map((item) => item.id === target.id ? completed : item) : [...data.schedules, completed] };
}

export function cancelPlannedSchedule(data: DemoData, target: Schedule): DemoData {
  if (target.status !== '已排期' || data.schedules.some((item) => item.id === target.id && item.status !== '已排期')) return data;
  const cancelled = { ...target, status: '已取消' as const };
  return { ...data, schedules: data.schedules.some((item) => item.id === target.id) ? data.schedules.map((item) => item.id === target.id ? cancelled : item) : [...data.schedules, cancelled] };
}

export function replaceRuleFrom(data: DemoData, ruleId: string, from: string, replacement: RecurrenceRule): DemoData {
  return { ...data, recurrenceRules: [...data.recurrenceRules.map((item) => item.id === ruleId ? truncateRule(item, from) : item), replacement], schedules: data.schedules.map((item) => item.recurrenceRuleId === ruleId && (item.recurrenceDay || item.day) >= from ? { ...item, recurrenceRuleId: replacement.id } : item) };
}

export function endRuleBefore(data: DemoData, ruleId: string, from: string): DemoData {
  return { ...data, recurrenceRules: data.recurrenceRules.map((item) => item.id === ruleId ? truncateRule(item, from) : item), schedules: data.schedules.map((item) => item.recurrenceRuleId === ruleId && (item.recurrenceDay || item.day) >= from && item.status === '已排期' ? { ...item, status: '已取消' as const } : item) };
}

function truncateRule(rule: RecurrenceRule, from: string): RecurrenceRule {
  const cutoff = dateAdd(from, -1);
  return { ...rule, endDate: rule.endDate && rule.endDate < cutoff ? rule.endDate : cutoff };
}

export function editCompletedSchedule(data: DemoData, original: Schedule, next: Schedule, revision: ScheduleRevision): DemoData {
  const stored = data.schedules.find((item) => item.id === original.id);
  if (!stored || stored.status !== '已完成') return data;
  const after: Schedule = { ...next, id: stored.id, status: '已完成', recurrenceDay: stored.recurrenceDay, recurrenceRuleId: stored.recurrenceRuleId };
  if (stored.day === after.day && stored.start === after.start && stored.end === after.end && stored.location === after.location && stored.format === after.format && stored.note === after.note && stored.participants.join('|') === after.participants.join('|')) return data;
  return { ...data, schedules: data.schedules.map((item) => item.id === stored.id ? after : item), scheduleRevisions: [...(data.scheduleRevisions || []), { ...revision, scheduleId: stored.id, before: stored, after }] };
}
