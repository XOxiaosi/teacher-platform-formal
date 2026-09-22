import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminAuthApi from '../api/adminAuth';
import * as adminTeachersApi from '../api/adminTeachers';
import * as adminActionsApi from '../api/adminActions';
import * as adminFeedbackApi from '../api/adminFeedback';
import * as adminUsageApi from '../api/adminUsage';
import { App } from './App';

vi.mock('../api/adminAuth');
vi.mock('../api/adminTeachers');
vi.mock('../api/adminActions');
vi.mock('../api/adminFeedback');
vi.mock('../api/adminUsage');

beforeEach(() => {
  vi.mocked(adminAuthApi.me).mockReset().mockResolvedValue(null);
  vi.mocked(adminAuthApi.login).mockReset().mockResolvedValue(undefined);
  vi.mocked(adminAuthApi.logout).mockReset().mockResolvedValue(undefined);
  vi.mocked(adminTeachersApi.listTeachers).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(adminFeedbackApi.listFeedback).mockReset().mockResolvedValue({ items: [], total: 0 });
  vi.mocked(adminFeedbackApi.getFeedbackSummary).mockReset().mockResolvedValue({
    total: 0,
    byStatus: [],
    byPriority: [],
    byCategory: [],
    recent: [],
  });
  vi.mocked(adminUsageApi.getAdminUsageSummary).mockReset().mockResolvedValue({
    from: '2026-07-02T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 },
    byProvider: [],
  });
  vi.mocked(adminActionsApi.listInvitations).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(adminActionsApi.createInvitation).mockReset();
  vi.mocked(adminActionsApi.revokeInvitation).mockReset();
  vi.mocked(adminActionsApi.getInteractions).mockReset().mockResolvedValue({
    total: 0,
    byStatus: {},
    avgDurationMs: null,
    maxDurationMs: null,
    errorRate: 0,
    lastInteractionAtTs: null,
  });
  vi.mocked(adminActionsApi.getHealth).mockReset().mockResolvedValue({
    ready: true,
    dbHealth: { ok: 0, missing: 0, migrationBehind: 0, unreachable: 0 },
    backup: { lastRunId: null, lastRunAtTs: null, databases: 0, success: null },
    migration: { applied: 12, expected: 12 },
    metrics: { requests5xx: 0, p95DurationMs: null },
  });
});

describe('Admin App 路由骨架', () => {
  it('/admin 根 + 未登录 → 重定向到登录页（渲染管理员登录）', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '管理员登录' })).toBeInTheDocument();
    expect(screen.queryByText('总览占位')).not.toBeInTheDocument();
  });

  it('已登录 → 总览占位页（不渲染登录页）', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue({ email: 'admin@example.com' });
    render(<App />);

    expect(await screen.findByText('总览占位')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '管理员登录' })).not.toBeInTheDocument();
  });

  it('登录成功后跳总览占位页', async () => {
    vi.mocked(adminAuthApi.me)
      .mockResolvedValueOnce(null) // 挂载：anon
      .mockResolvedValue({ email: 'admin@example.com' }); // 登录后 refresh
    render(<App />);
    await screen.findByRole('heading', { name: '管理员登录' });

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('总览占位')).toBeInTheDocument();
  });

  it('顶栏导航：教师总览页可进入并渲染列表', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue({ email: 'admin@example.com' });
    vi.mocked(adminTeachersApi.listTeachers).mockResolvedValue({
      items: [{
        id: 'teacher-1',
        email: 'a@b.com',
        displayName: '张三',
        status: 'active',
        databaseName: 'teacher_db_a',
        createdAtTs: '2026-08-01T02:00:00.000Z',
        updatedAtTs: '2026-08-02T02:00:00.000Z',
      }],
      total: 1,
    });
    render(<App />);
    await screen.findByText('总览占位');

    fireEvent.click(screen.getByRole('button', { name: '教师总览' }));

    expect(await screen.findByText('张三')).toBeInTheDocument();
  });

  it('顶栏导航：反馈看板可进入并渲染完整看板', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue({ email: 'admin@example.com' });
    vi.mocked(adminFeedbackApi.listFeedback).mockResolvedValue({
      items: [{
        id: 'req-1',
        teacherId: null,
        verbatimQuote: '希望增加批量导入功能',
        sourceType: 'teacher_feedback',
        sourceDbName: null,
        sourceTurnId: null,
        contextSummary: null,
        occurredAtTs: '2026-08-10T02:00:00.000Z',
        parsedIntent: '批量导入',
        category: 'feature',
        priority: 'high',
        status: 'new',
        linkedDesignDoc: null,
        linkedTaskId: null,
        linkedCommitSha: null,
        createdAtTs: '2026-08-10T02:00:00.000Z',
        updatedAtTs: '2026-08-10T02:00:00.000Z',
      }],
      total: 1,
    });
    render(<App />);
    await screen.findByText('总览占位');

    fireEvent.click(screen.getByRole('button', { name: '反馈看板' }));

    expect(await screen.findByRole('heading', { name: '反馈看板' })).toBeInTheDocument();
    expect(await screen.findByText('共 1 条反馈')).toBeInTheDocument();
    expect(screen.getByText('希望增加批量导入功能')).toBeInTheDocument();
  });

  it('顶栏导航：用量费用看板可进入并渲染', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue({ email: 'admin@example.com' });
    render(<App />);
    await screen.findByText('总览占位');

    fireEvent.click(screen.getByRole('button', { name: '用量费用' }));

    expect(await screen.findByRole('heading', { name: '用量费用看板' })).toBeInTheDocument();
    expect(screen.getByText('全平台 · 近 30 天')).toBeInTheDocument();
  });

  it('顶栏导航：系统健康看板可进入并渲染', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue({ email: 'admin@example.com' });
    render(<App />);
    await screen.findByText('总览占位');

    fireEvent.click(screen.getByRole('button', { name: '系统健康' }));

    expect(await screen.findByText('交互与健康看板')).toBeInTheDocument();
    expect(screen.getByText('Agent 交互统计')).toBeInTheDocument();
    expect(screen.getAllByText('系统健康').length).toBeGreaterThanOrEqual(2); // 导航 + 区块标题
  });

  it('未登录时受保护页一律重定向登录页（教师总览不可达）', async () => {
    vi.mocked(adminAuthApi.me).mockResolvedValue(null);
    render(<App />);
    await screen.findByRole('heading', { name: '管理员登录' });

    expect(screen.queryByRole('button', { name: '教师总览' })).not.toBeInTheDocument();
  });
});
