import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  getFeedbackSummary,
  listFeedback,
  updateFeedbackLinks,
  updateFeedbackStatus,
} from './adminFeedback';

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

const item = {
  id: 'req-1',
  teacherId: null,
  verbatimQuote: '希望增加批量导入功能',
  sourceType: 'teacher_feedback',
  sourceDbName: null,
  sourceTurnId: null,
  contextSummary: '教师在对话中提到希望支持批量导入学生',
  occurredAtTs: '2026-08-10T02:00:00.000Z',
  parsedIntent: '批量导入学生数据',
  category: 'feature',
  priority: 'high',
  status: 'new',
  linkedDesignDoc: null,
  linkedTaskId: null,
  linkedCommitSha: null,
  createdAtTs: '2026-08-10T02:00:00.000Z',
  updatedAtTs: '2026-08-10T02:00:00.000Z',
};

describe('adminFeedback api（契约：p7-admin-panel-design.md §6 + feedback-board）', () => {
  it('getFeedbackSummary GET /admin/feedback/summary?limit=20（默认）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        total: 3,
        byStatus: [{ status: 'new', count: 2 }, { status: 'triaged', count: 1 }],
        byPriority: [{ priority: 'urgent', count: 1 }, { priority: 'high', count: 2 }],
        byCategory: [{ category: 'feature', count: 3 }],
        recent: [{ id: 'req-1', teacherId: null, category: 'feature', priority: 'high', status: 'new', occurredAtTs: '2026-08-10T02:00:00.000Z' }],
      },
    }));

    const summary = await getFeedbackSummary();
    expect(summary.total).toBe(3);
    expect(summary.byStatus[0]).toEqual({ status: 'new', count: 2 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback/summary?limit=20', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('getFeedbackSummary 支持自定义 limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { total: 0, byStatus: [], byPriority: [], byCategory: [], recent: [] },
    }));

    await getFeedbackSummary(50);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback/summary?limit=50', expect.anything());
  });

  it('listFeedback 默认无 query；携带 page/pageSize/status/category/priority 过滤', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { items: [item], total: 1 },
    }));

    await expect(listFeedback()).resolves.toEqual({ items: [item], total: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback', expect.objectContaining({ method: 'GET' }));

    await listFeedback({
      page: 2,
      pageSize: 10,
      status: 'triaged',
      category: 'bug_report',
      priority: 'urgent',
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/admin/feedback?page=2&pageSize=10&status=triaged&category=bug_report&priority=urgent',
      expect.objectContaining({
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
      }),
    );
  });

  it('listFeedback 只发送已设置的过滤项（undefined 不进 query）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { items: [], total: 0 },
    }));

    await listFeedback({ status: 'new' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback?status=new', expect.anything());
  });

  it('updateFeedbackStatus PATCH /admin/feedback/:id（乐观锁 + changes.status）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...item, status: 'triaged', updatedAtTs: '2026-08-11T02:00:00.000Z' },
    }));

    const updated = await updateFeedbackStatus({
      requirementId: 'req/1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      status: 'triaged',
    });

    expect(updated.status).toBe('triaged');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback/req%2F1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
        changes: { status: 'triaged' },
      }),
    });
  });

  it('后端错误照常抛 ApiError（404 / VERSION_CONFLICT 409）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'NOT_FOUND', message: '反馈不存在' },
    }, 404));

    await expect(listFeedback()).rejects.toBeInstanceOf(ApiError);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: '已被他人更新' },
    }, 409));

    await expect(updateFeedbackStatus({
      requirementId: 'req-1',
      expectedUpdatedAt: 'stale',
      status: 'done',
    })).rejects.toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
  });

  it('updateFeedbackLinks PATCH /admin/feedback/:id（只含提供的关联字段，无 status）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...item, linkedTaskId: 'T-101', linkedDesignDoc: 'reports/architecture/demo.md', status: 'new' },
    }));

    const updated = await updateFeedbackLinks({
      requirementId: 'req/1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      linkedTaskId: 'T-101',
      linkedDesignDoc: 'reports/architecture/demo.md',
    });

    expect(updated.linkedTaskId).toBe('T-101');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback/req%2F1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
        changes: { linkedDesignDoc: 'reports/architecture/demo.md', linkedTaskId: 'T-101' },
      }),
    });
  });

  it('updateFeedbackLinks：未提供的字段不进 changes；空字符串 = 清除关联', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...item, linkedTaskId: '', linkedCommitSha: '' },
    }));

    await updateFeedbackLinks({
      requirementId: 'req-1',
      expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
      linkedTaskId: '',
      linkedCommitSha: '',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/feedback/req-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expectedUpdatedAt: '2026-08-10T02:00:00.000Z',
        changes: { linkedTaskId: '', linkedCommitSha: '' },
      }),
    });
  });
});
