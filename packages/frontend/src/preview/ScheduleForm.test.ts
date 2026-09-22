import { describe, expect, it } from 'vitest';
import { initialRuleEnd } from './ScheduleForm';
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
});
