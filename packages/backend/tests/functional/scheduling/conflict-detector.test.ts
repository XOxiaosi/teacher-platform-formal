import { describe, it, expect } from 'vitest';
import { detectConflicts, type TimeRange, type ScheduleWithTime } from '../../../src/features/scheduling/conflict-detector.js';

function makeSchedule(id: string, start: string, end: string): ScheduleWithTime {
  return {
    id,
    scheduledStart: new Date(start),
    scheduledEnd: new Date(end),
  };
}

describe('detectConflicts', () => {
  it('无重叠：返回空数组', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T11:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T12:00:00', '2025-01-01T13:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts).toEqual([]);
  });

  it('完全重叠：返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T11:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe('s1');
  });

  it('部分重叠（新日程开始落在已有日程内）：返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:30:00'),
      end: new Date('2025-01-01T11:30:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
  });

  it('部分重叠（新日程结束落在已有日程内）：返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T09:30:00'),
      end: new Date('2025-01-01T10:30:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
  });

  it('新日程包含已有日程：返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T09:00:00'),
      end: new Date('2025-01-01T12:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
  });

  it('已有日程包含新日程：返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:15:00'),
      end: new Date('2025-01-01T10:45:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
  });

  it('边界相接不算冲突（已有结束=新日程开始）', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T11:00:00'),
      end: new Date('2025-01-01T12:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts).toEqual([]);
  });

  it('边界相接不算冲突（新日程结束=已有开始）', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T09:00:00'),
      end: new Date('2025-01-01T10:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T10:00:00', '2025-01-01T11:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts).toEqual([]);
  });

  it('跨日时间范围有实际重叠时返回冲突', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T23:30:00'),
      end: new Date('2025-01-02T00:30:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-02T00:00:00', '2025-01-02T01:00:00'),
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.map((item) => item.id)).toEqual(['s1']);
  });

  it('多个已有日程中部分冲突：只返回冲突的', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T11:00:00'),
    };
    const existing = [
      makeSchedule('s1', '2025-01-01T08:00:00', '2025-01-01T09:00:00'), // 无冲突
      makeSchedule('s2', '2025-01-01T10:30:00', '2025-01-01T11:30:00'), // 冲突
      makeSchedule('s3', '2025-01-01T14:00:00', '2025-01-01T15:00:00'), // 无冲突
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe('s2');
  });

  it('已有列表为空：返回空数组', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T11:00:00'),
    };

    const conflicts = detectConflicts(newRange, []);
    expect(conflicts).toEqual([]);
  });

  it('排除已取消/已完成等非活跃状态的日程', () => {
    const newRange: TimeRange = {
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T11:00:00'),
    };
    const existing = [
      { id: 's1', scheduledStart: new Date('2025-01-01T10:00:00'), scheduledEnd: new Date('2025-01-01T11:00:00'), status: 'cancelled' },
      { id: 's2', scheduledStart: new Date('2025-01-01T10:00:00'), scheduledEnd: new Date('2025-01-01T11:00:00'), status: 'completed' },
      { id: 's3', scheduledStart: new Date('2025-01-01T10:00:00'), scheduledEnd: new Date('2025-01-01T11:00:00'), status: 'planned' },
    ];

    const conflicts = detectConflicts(newRange, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].id).toBe('s3');
  });
});