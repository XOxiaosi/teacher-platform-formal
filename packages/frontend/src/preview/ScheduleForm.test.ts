import { describe, expect, it } from 'vitest';
import { initialRuleEnd, persistedScheduleSources, prefillNewScheduleFromSource, scheduleSourceLabel } from './ScheduleForm';
import { createDemoData, type Schedule } from './data';
import { recurrenceScopeStart } from './ScheduleDetails';

describe('repeat edit draft restoration', () => {
  it('keeps a deliberately cleared end date when returning from confirmation', () => {
    expect(initialRuleEnd({ end: '' }, '2026-12-31')).toBe('');
  });
  it('uses the source rule end date only before an edit draft exists', () => {
    expect(initialRuleEnd(undefined, '2026-12-31')).toBe('2026-12-31');
  });
  it('cancels a moved exception from its original recurring slot', () => {
    expect(recurrenceScopeStart({ id: 'r@12', recurrenceDay: '2026-01-12', day: '2026-01-14', start: '10:00', end: '11:00', location: 'A', participants: [], format: '一对一', note: '', status: '已排期' })).toBe('2026-01-12');
  });
  it('only reads stored schedules and searches date, time, person, place, and format', () => {
    const data = createDemoData();
    const stored = { ...data.schedules[0], id: 'saved', day: '2026-09-10', start: '14:00', end: '16:00', location: '线上工作室', participants: ['s2'], format: '一对一' as const, createdAt: undefined };
    const rule = { ...data.recurrenceRules[0], id: 'rule-only', start: '18:00', end: '19:30' };
    const sourceData = { ...data, schedules: [stored], recurrenceRules: [rule] };
    expect(persistedScheduleSources(sourceData)).toEqual([stored]);
    for (const query of ['2026-09-10', '14:00', '王浩然', '线上', '一对一']) expect(persistedScheduleSources(sourceData, query)).toEqual([stored]);
    expect(scheduleSourceLabel(sourceData, stored)).toContain('王浩然 · 线上工作室 · 一对一');
  });
  it('copies only editable course fields into the new draft', () => {
    const source: Schedule = { id: 'old', day: '2026-09-01', start: '14:00', end: '16:00', location: '旧地点', participants: ['s1', 's2'], format: '小班', note: '旧备注', status: '已完成', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: 'old-v2', version: 'old-v2', recurrenceRuleId: 'rule-1', recurrenceDay: '2026-09-01' };
    const draft: Schedule = { id: 'fresh', day: '2026-09-20', start: '10:00', end: '12:00', location: '', participants: [], format: '一对一', note: '', status: '已排期' };
    expect(prefillNewScheduleFromSource(draft, source)).toEqual({ ...draft, start: '14:00', end: '16:00', location: '旧地点', participants: ['s1', 's2'], format: '小班', note: '旧备注' });
  });
});
