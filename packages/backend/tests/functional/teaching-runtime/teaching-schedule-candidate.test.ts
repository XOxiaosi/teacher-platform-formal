import { describe, expect, it } from 'vitest';
import { parseCreateCandidate } from '../../../src/app/confirmation/teaching-create-actions.js';

const weekly = { recurrence:'weekly',weekdays:[6],start:'16:00',end:'18:00',participants:['synthetic-d','synthetic-c','synthetic-b','synthetic-a'] };
describe('IC-14 prepare from known facts instead of repeated clarification', () => {
  it('uses the next not-yet-started Saturday in Beijing, without inventing a location', () => {
    const result = parseCreateCandidate('scheduling.create',weekly,new Date('2026-09-26T14:54:00Z'));
    expect(result).toMatchObject({ok:true,value:{day:'2026-10-03',weekdays:[6],format:'小班',location:'待补充',note:''}});
    if (!result.ok || result.value.kind !== 'schedule') throw new Error('candidate');
    expect(result.value.participants).toEqual(['synthetic-a','synthetic-b','synthetic-c','synthetic-d']);
    expect(result.value).not.toHaveProperty('endDate');
  });
  it('does not skip today before the lesson, including UTC/Beijing date differences', () => {
    expect(parseCreateCandidate('scheduling.create',weekly,new Date('2026-09-25T17:00:00Z'))).toMatchObject({ok:true,value:{day:'2026-09-26'}});
    expect(parseCreateCandidate('scheduling.create',weekly,new Date('2026-09-26T08:01:00Z'))).toMatchObject({ok:true,value:{day:'2026-10-03'}});
  });
  it('keeps explicit dates and accepts the weekday implied by that date', () => {
    const fields = { ...weekly, weekdays: undefined };
    expect(parseCreateCandidate('scheduling.create',{...fields,day:'2090-09-23',endDate:'2090-10-31'})).toMatchObject({ok:true,value:{day:'2090-09-23',endDate:'2090-10-31'}});
  });
  it('infers one-to-one and leaves missing location pending for a single lesson too', () => {
    expect(parseCreateCandidate('scheduling.create',{day:'2090-09-23',recurrence:'once',start:'16:00',end:'18:00',participants:['synthetic-a']})).toMatchObject({ok:true,value:{format:'一对一',location:'待补充',recurrence:'once'}});
  });
  it.each([
    {weekdays:[]},{weekdays:[0]},{weekdays:[8]},{weekdays:[6,6]},
    {participants:[]},{participants:['same','same']},{format:'未知'},
    {start:'下午4点'},{end:'15:00'},{day:'2090-02-30'},
    {endDate:'2026-10-02'},{endDate:'2090-02-30'},{location:123},
    {recurrence:'monthly'},{teacherId:'other'},
  ])('keeps invalid facts rejected: %j', patch => {
    expect(parseCreateCandidate('scheduling.create',{...weekly,...patch},new Date('2026-09-26T14:54:00Z')).ok).toBe(false);
  });
  it('does not guess when neither an explicit date nor a trusted clock is available', () => {
    expect(parseCreateCandidate('scheduling.create',weekly).ok).toBe(false);
    expect(parseCreateCandidate('scheduling.create',{...weekly,recurrence:'once',weekdays:undefined},new Date()).ok).toBe(false);
  });
});
