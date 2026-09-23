import { describe, expect, it } from 'vitest';
import type { DemoData, RecurrenceRule, Schedule } from './data';
import { schedulesInRange } from './recurrence';
import { cancelPlannedSchedule, completePlannedSchedule, editCompletedSchedule, endRuleBefore, replaceRuleFrom } from './schedule-mutations';

const rule: RecurrenceRule = { id: 'r1', startDate: '2026-01-05', weekdays: [1], enabled: true, start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '' };
const scheduled = (overrides: Partial<Schedule> = {}): Schedule => ({ id: 'r1@2026-01-12', recurrenceRuleId: 'r1', recurrenceDay: '2026-01-12', day: '2026-01-12', start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已排期', ...overrides });
const base = (schedules: Schedule[] = []): DemoData => ({ students: [{ id: 's1', name: '甲', grade: '', balance: 3, notes: [] }, { id: 's2', name: '乙', grade: '', balance: 4, notes: [] }], schedules, recurrenceRules: [rule], payments: [], memos: [], feedbacks: [], completionRecords: [], studioName: 'x' });

describe('preview schedule state mutations', () => {
  it('never extends a previously ended rule when acting on a restored future exception', () => {
    const ended = { ...base([scheduled({ day: '2026-01-26', recurrenceDay: '2026-01-26' })]), recurrenceRules: [{ ...rule, endDate: '2026-01-11' }] };
    const cancelled = endRuleBefore(ended, 'r1', '2026-01-26');
    expect(cancelled.recurrenceRules[0].endDate).toBe('2026-01-11');
    expect(schedulesInRange(cancelled, '2026-01-12', '2026-01-25')).toEqual([]);
    const replaced = replaceRuleFrom(ended, 'r1', '2026-01-26', { ...rule, id: 'r2', startDate: '2026-01-26' });
    expect(replaced.recurrenceRules[0].endDate).toBe('2026-01-11');
    expect(schedulesInRange(replaced, '2026-01-12', '2026-01-25')).toEqual([]);
  });
  it('keeps a materialized completion and ledger record unchanged after later rule replacement', () => {
    const completed = completePlannedSchedule(base(), scheduled());
    const replacement = { ...rule, id: 'r2', startDate: '2026-01-12', start: '11:00', end: '12:00' };
    const changed = replaceRuleFrom(completed, 'r1', '2026-01-12', replacement);
    expect(changed.schedules).toHaveLength(1); expect(changed.schedules[0].status).toBe('已完成');
    expect(changed.completionRecords).toHaveLength(1); expect(changed.students[0].balance).toBe(2);
  });
  it('cancels a future moved single exception when its original rule is ended', () => {
    const moved = scheduled({ day: '2026-01-14' });
    expect(endRuleBefore(base([moved]), 'r1', '2026-01-12').schedules[0].status).toBe('已取消');
  });
  it('does not duplicate or re-complete a cancelled or completed stored occurrence', () => {
    const cancelled = cancelPlannedSchedule(base(), scheduled());
    expect(completePlannedSchedule(cancelled, cancelled.schedules[0])).toEqual(cancelled);
    const done = completePlannedSchedule(base(), scheduled());
    expect(completePlannedSchedule(done, done.schedules[0])).toEqual(done);
  });
  it('ends the former rule before its original slot even when replacement starts later', () => {
    const changed = replaceRuleFrom(base(), 'r1', '2026-01-12', { ...rule, id: 'r2', startDate: '2026-01-20' });
    expect(changed.recurrenceRules.find((item) => item.id === 'r1')?.endDate).toBe('2026-01-11');
    expect(changed.recurrenceRules.find((item) => item.id === 'r2')?.startDate).toBe('2026-01-20');
  });
  it('keeps the former rule projection unchanged before a replacement becomes effective', () => {
    const replacement = { ...rule, id: 'r2', startDate: '2026-01-19', start: '14:00', end: '15:00', location: 'B' };
    const changed = replaceRuleFrom(base(), 'r1', '2026-01-19', replacement);
    expect(schedulesInRange(changed, '2026-01-12', '2026-01-12')).toEqual([expect.objectContaining({ recurrenceRuleId: 'r1', start: '10:00', location: 'A' })]);
    expect(schedulesInRange(changed, '2026-01-19', '2026-01-19')).toEqual([expect.objectContaining({ recurrenceRuleId: 'r2', start: '14:00', location: 'B' })]);
  });
  it('moves the active boundary occurrence to a later replacement start without leaving an old-slot projection', () => {
    const anchor = scheduled({ id: 'anchor', recurrenceDay: '2026-01-12', day: '2026-01-12' });
    const replacement = { ...rule, id: 'r2', startDate: '2026-01-14', weekdays: [3], start: '14:00', end: '15:30', location: 'B', note: '改期' };
    const changed = replaceRuleFrom(base([anchor]), 'r1', '2026-01-12', replacement);
    expect(changed.schedules[0]).toMatchObject({ id: 'anchor', status: '已排期', recurrenceRuleId: 'r2', recurrenceDay: '2026-01-14', day: '2026-01-14', start: '14:00', end: '15:30', location: 'B', note: '改期' });
    expect(schedulesInRange(changed, '2026-01-12', '2026-01-12')).toEqual([]);
    expect(schedulesInRange(changed, '2026-01-14', '2026-01-14')).toHaveLength(1);
    expect(schedulesInRange(changed, '2026-01-14', '2026-01-14')[0]).toMatchObject({ id: 'anchor', recurrenceRuleId: 'r2', day: '2026-01-14' });
  });
  it('keeps an equal-boundary anchor singular and only reattaches later active exceptions', () => {
    const anchor = scheduled({ id: 'anchor' });
    const laterException = scheduled({ id: 'later', recurrenceDay: '2026-01-19', day: '2026-01-20', start: '13:00', end: '14:00', location: '单独调整' });
    const replacement = { ...rule, id: 'r2', startDate: '2026-01-12', weekdays: [1], start: '11:00', end: '12:00' };
    const changed = replaceRuleFrom(base([anchor, laterException]), 'r1', '2026-01-12', replacement);
    expect(changed.schedules.find((item) => item.id === 'anchor')).toMatchObject({ recurrenceRuleId: 'r2', recurrenceDay: '2026-01-12', day: '2026-01-12', start: '11:00', end: '12:00' });
    expect(changed.schedules.find((item) => item.id === 'later')).toMatchObject({ recurrenceRuleId: 'r2', recurrenceDay: '2026-01-19', day: '2026-01-20', start: '13:00', end: '14:00', location: '单独调整' });
    expect(schedulesInRange(changed, '2026-01-12', '2026-01-12')).toHaveLength(1);
  });
  it('preserves completed and cancelled history while reattaching it to suppress replacement projections', () => {
    const completed = scheduled({ id: 'done', status: '已完成' });
    const cancelled = scheduled({ id: 'cancelled', recurrenceDay: '2026-01-19', day: '2026-01-19', status: '已取消' });
    const changed = replaceRuleFrom(base([completed, cancelled]), 'r1', '2026-01-12', { ...rule, id: 'r2', startDate: '2026-01-12' });
    expect(changed.schedules.find((item) => item.id === 'done')).toEqual({ ...completed, recurrenceRuleId: 'r2' });
    expect(changed.schedules.find((item) => item.id === 'cancelled')).toEqual({ ...cancelled, recurrenceRuleId: 'r2' });
    expect(changed.completionRecords).toEqual([]);
    expect(schedulesInRange(changed, '2026-01-12', '2026-01-12')).toEqual([expect.objectContaining({ id: 'done', status: '已完成', recurrenceRuleId: 'r2' })]);
    expect(schedulesInRange(changed, '2026-01-19', '2026-01-19')).toEqual([expect.objectContaining({ id: 'cancelled', status: '已取消', recurrenceRuleId: 'r2' })]);
  });
  it('edits every completed-course field without changing the original ledger or balance', () => {
    const done = completePlannedSchedule(base(), scheduled());
    const next = { ...done.schedules[0], day: '2026-01-14', start: '13:00', end: '14:30', location: 'B', participants: ['s2'], format: '一对一' as const, note: '课后确认' };
    const changed = editCompletedSchedule(done, done.schedules[0], next, { id: 'sr1', scheduleId: done.schedules[0].id, changedAt: '2026-01-15T00:00:00.000Z', before: done.schedules[0], after: next });
    expect(changed.schedules[0]).toMatchObject({ id: done.schedules[0].id, status: '已完成', day: '2026-01-14', start: '13:00', location: 'B', participants: ['s2'], note: '课后确认' });
    expect(changed.completionRecords).toEqual(done.completionRecords); expect(changed.students).toEqual(done.students);
    expect(changed.scheduleRevisions).toHaveLength(1);
    expect(editCompletedSchedule(changed, done.schedules[0], next, { id: 'sr2', scheduleId: done.schedules[0].id, changedAt: '2026-01-15T00:01:00.000Z', before: done.schedules[0], after: next })).toEqual(changed);
  });
});
