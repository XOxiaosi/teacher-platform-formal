import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { getTeacherDetail, listTeachers } from './adminTeachers';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const teacher = {
  id: 'teacher-1',
  email: 'a@b.com',
  displayName: '张三',
  status: 'active',
  databaseName: 'teacher_db_a',
  createdAtTs: '2026-08-01T02:00:00.000Z',
  updatedAtTs: '2026-08-02T02:00:00.000Z',
};

describe('admin teachers api', () => {
  it('listTeachers GET /admin/teachers：默认无 query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { items: [teacher], total: 1 },
    }));

    await expect(listTeachers()).resolves.toEqual({ items: [teacher], total: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/teachers', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('listTeachers 携带 status/page/pageSize 过滤参数', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { items: [], total: 0 },
    }));

    await listTeachers({ status: 'disabled', page: 2, pageSize: 20 });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/teachers?status=disabled&page=2&pageSize=20', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('getTeacherDetail GET /admin/teachers/:id 返回详情（含聚合与 degraded 标记）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        teacher,
        aggregates: {
          studentCount: 5,
          scheduleCount: 8,
          lessonCount: 12,
          paymentCount: 3,
          feedbackCount: 2,
          agentExecutionCount: 20,
          lastInteractionAtTs: '2026-08-02T04:00:00.000Z',
          recentExecutions: [{ id: 'exec-1', status: 'succeeded', startedAtTs: '2026-08-02T04:00:00.000Z', finishedAtTs: null, summary: '查课表' }],
        },
        degraded: false,
        degradedReason: null,
      },
    }));

    const detail = await getTeacherDetail('teacher-1');
    expect(detail.teacher.email).toBe('a@b.com');
    expect(detail.aggregates?.studentCount).toBe(5);
    expect(detail.degraded).toBe(false);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/teachers/teacher-1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('后端错误照常抛 ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'NOT_FOUND', message: '教师不存在' },
    }, 404));

    await expect(getTeacherDetail('missing')).rejects.toBeInstanceOf(ApiError);
  });
});
