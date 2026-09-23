import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelSchedule, createSchedule, restoreSchedule, type CreateScheduleRequest } from './schedules';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSuccess(data: unknown = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  } as Response);
}

describe('schedules API client', () => {
  it('类型契约区分正式课程与非课程日程', () => {
    const formal: CreateScheduleRequest = {
      clientRequestId: 'schedule-type-0001',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '线上',
      classFormat: 'one_to_one',
      scheduledStart: '2030-07-25T19:00:00+08:00',
      scheduledEnd: '2030-07-25T20:00:00+08:00',
    };
    const meeting: CreateScheduleRequest = {
      clientRequestId: 'schedule-type-0002',
      type: 'meeting',
      title: '教研会议',
      scheduledStart: '2030-07-25T19:00:00+08:00',
      scheduledEnd: '2030-07-25T20:00:00+08:00',
    };
    // @ts-expect-error 正式课程不允许课程名称。
    const titledLesson: CreateScheduleRequest = { ...formal, title: '数学课' };
    // @ts-expect-error 非课程日程必须有标题。
    const untitledMeeting: CreateScheduleRequest = { ...meeting, title: undefined };

    expect(formal.type).toBe('lesson');
    expect(meeting.type).toBe('meeting');
    expect(titledLesson.title).toBe('数学课');
    expect(untitledMeeting.title).toBeUndefined();
  });

  it('正式 lesson 创建发送结构化课程字段，不发送 title，并使用 session cookie 身份', async () => {
    const fetchMock = mockSuccess({
      schedule: { id: 'schedule-1' },
      conflicts: [],
    });

    await createSchedule('teacher-1', {
      clientRequestId: 'schedule-create-0001',
      type: 'lesson',
      participantIds: ['student-1', 'student-2'],
      location: '工作室 A',
      classFormat: 'small_group',
      operationalNote: '课前准备小测纸',
      scheduledStart: '2030-07-24T19:00:00+08:00',
      scheduledEnd: '2030-07-24T20:30:00+08:00',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/schedules', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'schedule-create-0001',
        type: 'lesson',
        participantIds: ['student-1', 'student-2'],
        location: '工作室 A',
        classFormat: 'small_group',
        operationalNote: '课前准备小测纸',
        scheduledStart: '2030-07-24T19:00:00+08:00',
        scheduledEnd: '2030-07-24T20:30:00+08:00',
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('x-teacher-id');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1] && (fetchMock.mock.calls[0]?.[1] as RequestInit).body))).not.toHaveProperty('title');
  });

  it('正式 lesson 没有 operationalNote 时不伪造该字段', async () => {
    const fetchMock = mockSuccess({
      schedule: { id: 'schedule-2' },
      conflicts: [],
    });

    await createSchedule('teacher-1', {
      clientRequestId: 'schedule-create-0002',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '线上',
      classFormat: 'one_to_one',
      scheduledStart: '2030-07-25T19:00:00+08:00',
      scheduledEnd: '2030-07-25T20:00:00+08:00',
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.credentials).toBe('include');
    expect(JSON.parse(String(request?.body))).toEqual({
      clientRequestId: 'schedule-create-0002',
      type: 'lesson',
      participantIds: ['student-1'],
      location: '线上',
      classFormat: 'one_to_one',
      scheduledStart: '2030-07-25T19:00:00+08:00',
      scheduledEnd: '2030-07-25T20:00:00+08:00',
    });
  });

  it('取消和恢复课程时对 scheduleId 做 URL 编码，并使用 session cookie 身份', async () => {
    const fetchMock = mockSuccess({ id: 'schedule/1' });

    await cancelSchedule('teacher-1', 'schedule/1?x=1');
    await restoreSchedule('teacher-1', 'schedule/1?x=1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/schedules/schedule%2F1%3Fx%3D1/cancel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/schedules/schedule%2F1%3Fx%3D1/restore', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  });
});
