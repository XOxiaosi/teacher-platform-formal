import { describe, expect, it } from 'vitest';
import type { DemoData, RecurrenceRule, Schedule } from './data';
import { changeSummary, dateAdd, recurrenceConflict, recurrenceSplitBoundary, scheduleFromRule, schedulesInRange } from './recurrence';

const rule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  id: 'r1', startDate: '2026-01-05', weekdays: [1], enabled: true, start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '', ...overrides,
});
const data = (rules: RecurrenceRule[], schedules: Schedule[] = []): DemoData => ({ students: [], schedules, recurrenceRules: rules, payments: [], memos: [], feedbacks: [], completionRecords: [], studioName: '演示' });

describe('recurrence projection', () => {
  it('释放已改时例外的原时段，但仍检查例外的真实时段', () => {
    const existing = rule({ endDate: '2026-01-05' });
    const moved = { ...scheduleFromRule(existing, '2026-01-05'), start: '12:00', end: '13:00' };
    const state = data([existing], [moved]);
    expect(recurrenceConflict(state, rule({ id: 'new', endDate: '2026-01-05' }))).toBe(false);
    expect(recurrenceConflict(state, rule({ id: 'new', endDate: '2026-01-05', start: '12:30', end: '13:30' }))).toBe(true);
  });

  it('恢复规则不会把自身已完成例外误认作冲突', () => {
    const candidate = rule();
    const completed = { ...scheduleFromRule(candidate, '2026-01-05'), status: '已完成' as const };
    expect(recurrenceConflict(data([{ ...candidate, enabled: false }], [completed]), candidate, candidate.id)).toBe(false);
  });

  it('无限规则只跳过有限例外，后续真实交集仍拒绝', () => {
    const existing = rule();
    const cancellations = ['2026-01-05', '2026-01-12'].map((day) => ({ ...scheduleFromRule(existing, day), status: '已取消' as const }));
    expect(recurrenceConflict(data([existing], cancellations), rule({ id: 'new' }))).toBe(true);
    expect(recurrenceConflict(data([existing], cancellations), rule({ id: 'new', endDate: '2026-01-12' }))).toBe(false);
  });

  it('候选规则移动后的例外不能撞上另一规则的实际排期', () => {
    const candidate = rule();
    const exception = { ...scheduleFromRule(candidate, '2026-01-05'), day: '2026-01-06' };
    const other = rule({ id: 'other', weekdays: [2] });
    expect(recurrenceConflict(data([candidate, other], [exception]), candidate, candidate.id)).toBe(true);
  });
  it('projects any requested future week rather than a hidden eight-week window', () => {
    const projected = schedulesInRange(data([rule()]), '2027-07-05', '2027-07-11');
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: 'r1@2027-07-05', recurrenceDay: '2027-07-05' });
  });

  it('keeps an explicit cancelled exception instead of regenerating it', () => {
    const cancelled: Schedule = { id: 'r1@2026-01-12', day: '2026-01-12', recurrenceRuleId: 'r1', recurrenceDay: '2026-01-12', start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已取消' };
    const projected = schedulesInRange(data([rule()], [cancelled]), '2026-01-12', '2026-01-12');
    expect(projected).toEqual([cancelled]);
  });

  it('detects a future weekly intersection even when it is outside the visible week', () => {
    const existing = rule({ id: 'existing', startDate: '2026-01-05', weekdays: [3], start: '10:30', end: '11:30' });
    const candidate = rule({ id: 'candidate', startDate: '2026-02-01', weekdays: [3], start: '10:00', end: '11:00' });
    expect(recurrenceConflict(data([existing]), candidate)).toBe(true);
  });

  it('also checks stored single-occurrence exceptions against a new future rule', () => {
    const exception: Schedule = { id: 'r0@2026-03-02', recurrenceRuleId: 'r0', recurrenceDay: '2026-03-02', day: '2026-03-02', start: '10:30', end: '11:30', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已排期' };
    expect(recurrenceConflict(data([], [exception]), rule({ startDate: '2026-02-01', weekdays: [1], start: '10:00', end: '11:00' }))).toBe(true);
  });

  it('allows a finite conflicting rule when every matching occurrence is explicitly cancelled', () => {
    const finite = rule({ id: 'finite', endDate: '2026-01-05' });
    const cancelled: Schedule = { id: 'finite@2026-01-05', recurrenceRuleId: 'finite', recurrenceDay: '2026-01-05', day: '2026-01-05', start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已取消' };
    expect(recurrenceConflict(data([finite], [cancelled]), rule({ id: 'new', startDate: '2026-01-05', endDate: '2026-01-05' }))).toBe(false);
  });

  it('uses calendar date arithmetic', () => expect(dateAdd('2026-01-31', 1)).toBe('2026-02-01'));

  it('splits a moved exception from its original recurring slot, not its new date', () => {
    const before: Schedule = { id: 'r1@2026-01-12', recurrenceRuleId: 'r1', recurrenceDay: '2026-01-12', day: '2026-01-14', start: '10:00', end: '11:00', location: 'A', participants: ['s1'], format: '一对一', note: '', status: '已排期' };
    const after = { ...before, day: '2026-01-20' };
    expect(recurrenceSplitBoundary(before, after)).toEqual({ previousRuleEnds: '2026-01-11', replacementStarts: '2026-01-20' });
  });

  it('uses the teacher-facing Chinese date in edit summaries while keeping ISO data intact', () => {
    const before = scheduleFromRule(rule(), '2026-01-05');
    const after = { ...before, day: '2026-01-12' };
    expect(changeSummary(before, after, 'this')).toMatchObject({
      before: '2026年1月5日 10:00–11:00 · A · 一对一',
      after: '2026年1月12日 10:00–11:00 · A · 一对一',
    });
    expect(before.day).toBe('2026-01-05');
    expect(after.day).toBe('2026-01-12');
  });
});
