import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { createRequirement, listRequirements, updateRequirement } from './requirements';

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

const requirement = {
  id: 'req-1',
  teacherId: 'teacher-1',
  verbatimQuote: '手机端日程不好用',
  sourceType: null,
  sourceDbName: null,
  sourceTurnId: null,
  contextSummary: '移动端日程体验',
  occurredAtTs: '2026-08-31T02:00:00.000Z',
  parsedIntent: '希望有纵向日程',
  category: 'ux',
  priority: 'high',
  status: 'new',
  linkedDesignDoc: null,
  linkedTaskId: null,
  linkedCommitSha: null,
  createdAtTs: '2026-08-31T02:00:00.000Z',
  updatedAtTs: '2026-08-31T02:00:00.000Z',
};

describe('requirements api', () => {
  it('createRequirement POST /requirements 发映射后的 body（无 teacher header）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: requirement }, 201));

    await createRequirement('teacher-1', {
      verbatimQuote: '手机端日程不好用',
      contextSummary: '移动端日程体验',
      parsedIntent: '希望有纵向日程',
      category: 'ux',
      priority: 'high',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        verbatimQuote: '手机端日程不好用',
        contextSummary: '移动端日程体验',
        parsedIntent: '希望有纵向日程',
        category: 'ux',
        priority: 'high',
      }),
    });
  });

  it('listRequirements GET /requirements 返回 items 列表', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { items: [requirement], total: 1 },
    }));

    await expect(listRequirements('teacher-1')).resolves.toEqual({ items: [requirement], total: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/requirements', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('updateRequirement PATCH /requirements/:id 带乐观锁 expectedUpdatedAt + changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...requirement, priority: 'urgent' },
    }));

    await updateRequirement('teacher-1', 'req-1', {
      expectedUpdatedAt: '2026-08-31T02:00:00.000Z',
      changes: { category: 'ux', priority: 'urgent' },
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/requirements/req-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expectedUpdatedAt: '2026-08-31T02:00:00.000Z',
        changes: { category: 'ux', priority: 'urgent' },
      }),
    });
  });

  it('后端错误照常抛 ApiError（如 VERSION_CONFLICT 由页面处理）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'VERSION_CONFLICT', message: '记录已被其他操作更新，请刷新后重试', field: 'expectedUpdatedAt' },
    }, 409));

    await expect(updateRequirement('teacher-1', 'req-1', {
      expectedUpdatedAt: '2026-08-31T02:00:00.000Z',
      changes: { priority: 'high' },
    })).rejects.toBeInstanceOf(ApiError);
  });
});
