import { describe, expect, it, vi } from 'vitest';
import type { CommonError, Result } from '@teacher-platform/contracts';

let calendarModule: Record<string, unknown> | null = null;
try {
  calendarModule = await import('../../../src/app/agenda/business-calendar.js');
} catch {
  // A3 production module is intentionally absent at the red-test gate.
}

interface TodayWindow {
  businessDate: string;
  windowStart: Date;
  windowEndExclusive: Date;
}

interface WeekWindow {
  weekStart: string;
  weekEndExclusive: string;
  days: string[];
  windowStart: Date;
  windowEndExclusive: Date;
}

interface BusinessCalendarApi {
  getTodayWindow(input: {
    now: Date;
    timeZone: 'Asia/Shanghai';
  }): Result<TodayWindow, CommonError>;
  getWeekWindow(input: {
    now: Date;
    weekStart?: string;
    timeZone: 'Asia/Shanghai';
  }): Result<WeekWindow, CommonError>;
  getOverlappingBusinessDates(input: {
    startAt: Date;
    endAt: Date;
    days: readonly string[];
    timeZone: 'Asia/Shanghai';
  }): string[];
}

function api(): BusinessCalendarApi {
  expect(calendarModule, 'business-calendar module must exist before behavior can pass').not.toBeNull();
  if (!calendarModule) throw new Error('business-calendar module is missing');
  return calendarModule as unknown as BusinessCalendarApi;
}

describe('Agenda Business Calendar', () => {
  it('UTC跨日时按Asia/Shanghai生成可信Today半开窗口', () => {
    const calendar = api();
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('不得读取本机时间');
    });
    try {
      const result = calendar.getTodayWindow({
        now: new Date('2030-07-21T16:30:00.000Z'),
        timeZone: 'Asia/Shanghai',
      });

      expect(result).toEqual({
        ok: true,
        value: {
          businessDate: '2030-07-22',
          windowStart: new Date('2030-07-21T16:00:00.000Z'),
          windowEndExclusive: new Date('2030-07-22T16:00:00.000Z'),
        },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('weekStart缺失时从可信instant推导周一到下周一', () => {
    const result = api().getWeekWindow({
      now: new Date('2030-07-24T03:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        weekStart: '2030-07-22',
        weekEndExclusive: '2030-07-29',
        days: [
          '2030-07-22', '2030-07-23', '2030-07-24', '2030-07-25',
          '2030-07-26', '2030-07-27', '2030-07-28',
        ],
        windowStart: new Date('2030-07-21T16:00:00.000Z'),
        windowEndExclusive: new Date('2030-07-28T16:00:00.000Z'),
      },
    });
  });

  it('显式合法周一产生完全相同的七天窗口', () => {
    const result = api().getWeekWindow({
      now: new Date('2035-01-01T00:00:00.000Z'),
      weekStart: '2030-07-22',
      timeZone: 'Asia/Shanghai',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        weekStart: '2030-07-22',
        weekEndExclusive: '2030-07-29',
        days: expect.arrayContaining(['2030-07-22', '2030-07-28']),
      },
    });
  });

  it.each(['2030-02-30', '2030-07-23', '2030-7-22', '2030-07-22T00:00:00+08:00'])(
    '非法或非周一weekStart整体拒绝：%s',
    (weekStart) => {
      expect(api().getWeekWindow({
        now: new Date('2030-07-24T03:00:00.000Z'),
        weekStart,
        timeZone: 'Asia/Shanghai',
      })).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'weekStart' }),
      });
    },
  );

  it('跨日lesson只进入实际相交日，午夜结束不重复到下一天', () => {
    const dates = api().getOverlappingBusinessDates({
      startAt: new Date('2030-07-22T15:30:00.000Z'),
      endAt: new Date('2030-07-23T16:00:00.000Z'),
      days: ['2030-07-22', '2030-07-23', '2030-07-24', '2030-07-25'],
      timeZone: 'Asia/Shanghai',
    });

    expect(dates).toEqual(['2030-07-22', '2030-07-23']);
  });
});
