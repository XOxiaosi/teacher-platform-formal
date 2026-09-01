import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime } from './date-format';

describe('formatDateTime', () => {
  it('把 ISO 时间格式化为中文日期时间', () => {
    expect(formatDateTime('2026-07-10T10:00:00.000Z')).toBe('2026年7月10日 18:00');
  });

  it('把日期格式化为中文日期', () => {
    expect(formatDate('2026-07-01')).toBe('2026年7月1日');
  });

  it('把时间格式化为小时分钟', () => {
    expect(formatTime('2026-07-10T11:00:00.000Z')).toBe('19:00');
  });

  it('无法解析时返回原始值', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
