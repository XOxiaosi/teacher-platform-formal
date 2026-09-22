import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  createInvitation,
  listInvitations,
  revokeInvitation,
  getHealth,
  getInteractions,
  pollBackupStatus,
  triggerBackup,
  triggerRestore,
  updateTeacherStatus,
} from './adminActions';

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

describe('admin actions api', () => {
  it('createInvitation POST /admin/invitations 不携带密码', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { invitation: { id: 'i1', email: 'a@b.com', status: 'pending', expiresAtTs: '2026-08-04T00:00:00Z', createdAtTs: '2026-08-01T00:00:00Z' }, token: 'raw' },
    }, 201));

    await createInvitation({ email: 'a@b.com', expiresInHours: 72 });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'a@b.com', expiresInHours: 72 }),
    });
  });

  it('listInvitations 与 revokeInvitation 使用管理接口', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: { items: [] } }));
    await listInvitations();
    await revokeInvitation('i/1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/admin/invitations');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/admin/invitations/i%2F1/revoke');
  });

  it('updateTeacherStatus PATCH /admin/teachers/:id/status {status}', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { id: 't1', status: 'disabled' },
    }));

    await updateTeacherStatus('t1', 'disabled');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/teachers/t1/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status: 'disabled' }),
    });
  });

  it('triggerBackup POST /admin/backup → {jobId}（带 teacherId 时传 body）', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: { jobId: 'job-1' } }));

    await expect(triggerBackup('t1')).resolves.toEqual({ jobId: 'job-1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ teacherId: 't1' }),
    });
  });

  it('pollBackupStatus GET /admin/backup/status?jobId=', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: { status: 'succeeded', detail: 'MANIFEST ok' },
    }));

    await expect(pollBackupStatus('job-1')).resolves.toEqual({ status: 'succeeded', detail: 'MANIFEST ok' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/backup/status?jobId=job-1', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('triggerRestore POST /admin/restore?confirm=1 带演练目标', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, data: { ok: true } }));

    await triggerRestore({ targetDatabaseName: 'teacher_db_demo_restore_20260831' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/restore?confirm=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ targetDatabaseName: 'teacher_db_demo_restore_20260831' }),
    });
  });

  it('getHealth GET /admin/health', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        ready: true,
        dbHealth: { ok: 2, missing: 0, migrationBehind: 1, unreachable: 0 },
        backup: { lastRunId: 'run-1', lastRunAtTs: '2026-08-31T02:00:00.000Z', databases: 3, success: true },
        migration: { applied: 12, expected: 12 },
        metrics: { requests5xx: 0, p95DurationMs: 320 },
      },
    }));

    const health = await getHealth();
    expect(health.ready).toBe(true);
    expect(health.dbHealth.ok).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/health', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
    });
  });

  it('getInteractions GET /admin/interactions 携带过滤参数', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: true,
      data: {
        teacherId: 't1',
        total: 10,
        byStatus: { succeeded: 8, failed: 2 },
        avgDurationMs: 500,
        maxDurationMs: 900,
        errorRate: 0.2,
        lastInteractionAtTs: '2026-08-31T04:00:00.000Z',
      },
    }));

    await getInteractions({ teacherId: 't1', from: '2026-08-01', to: '2026-08-31' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/interactions?teacherId=t1&from=2026-08-01&to=2026-08-31',
      { method: 'GET', headers: { 'content-type': 'application/json' }, credentials: 'include' },
    );
  });

  it('错误信封照常抛 ApiError（如 VALIDATION_ERROR）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '分类不合法', field: 'category' },
    }, 400));

    await expect(triggerRestore({ targetDatabaseName: 'bad-name' })).rejects.toBeInstanceOf(ApiError);
  });
});
