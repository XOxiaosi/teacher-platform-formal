import { afterEach, describe, expect, it, vi } from 'vitest';

interface AgendaTimeModule {
  formatBusinessDate?: (date: string) => string;
  addBusinessDays?: (date: string, amount: number) => string;
  isMondayBusinessDate?: (date: string) => boolean;
  formatAgendaTime?: (instant: string) => string | null;
  formatAgendaTimeRange?: (startAt?: string, endAt?: string) => string | null;
}

async function loadAgendaTime(): Promise<Required<AgendaTimeModule> | undefined> {
  let module: AgendaTimeModule = {};
  try {
    const modulePath = './agenda-time';
    module = await import(/* @vite-ignore */ modulePath) as unknown as AgendaTimeModule;
  } catch {
    module = {};
  }
  expect(module).toMatchObject({
    formatBusinessDate: expect.any(Function),
    addBusinessDays: expect.any(Function),
    isMondayBusinessDate: expect.any(Function),
    formatAgendaTime: expect.any(Function),
    formatAgendaTimeRange: expect.any(Function),
  });
  if (
    !module.formatBusinessDate
    || !module.addBusinessDays
    || !module.isMondayBusinessDate
    || !module.formatAgendaTime
    || !module.formatAgendaTimeRange
  ) return undefined;
  return module as Required<AgendaTimeModule>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Agenda business date and instant formatting', () => {
  it('严格BusinessDate格式化为中文月日与星期', async () => {
    const time = await loadAgendaTime();
    if (!time) return;

    expect(time.formatBusinessDate('2030-07-22')).toBe('7月22日 · 星期一');
    expect(time.formatBusinessDate('2030-07-28')).toBe('7月28日 · 星期日');
  });

  it('按UTC日历运算跨月、跨年、闰日和负向周', async () => {
    const time = await loadAgendaTime();
    if (!time) return;

    expect(time.addBusinessDays('2030-07-29', 7)).toBe('2030-08-05');
    expect(time.addBusinessDays('2030-01-01', -7)).toBe('2029-12-25');
    expect(time.addBusinessDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(time.addBusinessDays('2032-02-29', 1)).toBe('2032-03-01');
  });

  it('拒绝宽松、溢出和非周一日期', async () => {
    const time = await loadAgendaTime();
    if (!time) return;

    expect(() => time.formatBusinessDate('2030-7-22')).toThrow(RangeError);
    expect(() => time.addBusinessDays('2030-02-30', 1)).toThrow(RangeError);
    expect(time.isMondayBusinessDate('2030-07-22')).toBe(true);
    expect(time.isMondayBusinessDate('2030-07-23')).toBe(false);
    expect(time.isMondayBusinessDate('bad')).toBe(false);
  });

  it('绝对instant固定按Asia/Shanghai显示且无效值返回null', async () => {
    const time = await loadAgendaTime();
    if (!time) return;

    expect(time.formatAgendaTime('2030-07-24T01:05:00.000Z')).toBe('09:05');
    expect(time.formatAgendaTimeRange(
      '2030-07-24T01:05:00.000Z',
      '2030-07-24T02:35:00.000Z',
    )).toBe('09:05–10:35');
    expect(time.formatAgendaTime('invalid')).toBeNull();
    expect(time.formatAgendaTimeRange('invalid', '2030-07-24T02:35:00.000Z')).toBeNull();
  });

  it('不读取Date.now或本机当前日期', async () => {
    const time = await loadAgendaTime();
    if (!time) return;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('local clock must not be read');
    });

    expect(time.formatBusinessDate('2030-07-22')).toBe('7月22日 · 星期一');
    expect(time.addBusinessDays('2030-07-22', 7)).toBe('2030-07-29');
    expect(time.formatAgendaTime('2030-07-24T01:05:00.000Z')).toBe('09:05');
  });
});
