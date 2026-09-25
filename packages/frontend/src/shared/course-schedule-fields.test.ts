import { describe, expect, it } from 'vitest';
import type { ScheduleData } from '../api/types';
import { courseScheduleFields } from './course-schedule-fields';

function schedule(overrides: Partial<ScheduleData> = {}): ScheduleData {
  return {
    id: 'schedule-1', teacherId: 'teacher-1', studentId: 'student-1', type: 'lesson',
    title: '不应进入五字段的课程标题', scheduledStart: '2030-07-24T01:00:00.000Z',
    scheduledEnd: '2030-07-24T02:30:00.000Z', status: 'planned', confidence: null,
    pendingFields: null, sourceInput: null, parentId: null,
    createdAt: '2030-07-24T00:00:00.000Z', updatedAt: '2030-07-24T00:00:00.000Z', ...overrides,
  };
}

describe('courseScheduleFields', () => {
  it('只返回五字段，且不从兼容标题推断信息', () => {
    expect(courseScheduleFields(schedule({
      location: '工作室 A', classFormat: 'one_to_one', operationalNote: '课前小测',
      participants: [{ id: 'student-1', name: '张三' }],
    }))).toEqual({
      time: '2030年7月24日 09:00 – 2030年7月24日 10:30', location: '工作室 A',
      participants: '张三', classFormat: '一对一', note: '课前小测',
    });
  });

  it('正式字段缺失时只返回明确的缺失文案', () => {
    expect(courseScheduleFields(schedule())).toMatchObject({
      location: '地点待补充', participants: '参与人待补充', classFormat: '形式待补充', note: '暂无备注',
    });
  });
});
