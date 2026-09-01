import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import * as authApi from '../api/auth';
import type { MeData } from '../api/auth';

const demoMe: MeData = { id: 'demo-teacher', email: 'demo@example.com', displayName: '演示老师' };

// TeacherProvider 挂载时注册 onSessionExpired；此处捕获以便在用例里触发「会话过期」
const { sessionExpiredHandlers } = vi.hoisted(() => ({ sessionExpiredHandlers: [] as Array<() => void> }));

vi.mock('../api/auth');

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    onSessionExpired: (handler: () => void) => {
      sessionExpiredHandlers.push(handler);
      return () => {
        const index = sessionExpiredHandlers.indexOf(handler);
        if (index >= 0) sessionExpiredHandlers.splice(index, 1);
      };
    },
  };
});

vi.mock('../features/agent', () => ({
  AgentPage: ({ onNavigate }: { onNavigate: (path: string) => void }) => (
    <div>
      <button type="button" onClick={() => onNavigate('/today?focusMemo=memo%2F1')}>进入Today focus</button>
      <button type="button" onClick={() => onNavigate('/today?focusMemo=a&focusMemo=b')}>进入Today非法focus</button>
      <button type="button" onClick={() => onNavigate('/schedules?weekStart=2030-07-22&focus=schedule%2F1')}>进入显式周</button>
      <button type="button" onClick={() => onNavigate('/schedules?weekStart=2030-07-23')}>进入非法周</button>
      <button type="button" onClick={() => onNavigate('/students/student%2F1?tab=lessons&focus=lesson%2F1')}>进入学生对象</button>
      <button type="button" onClick={() => onNavigate('/login')}>进入登录页</button>
    </div>
  ),
}));

vi.mock('../features/dashboard/DashboardPage', () => ({
  DashboardPage: ({ focusMemo }: { focusMemo?: string }) => <div>Today focus: {focusMemo ?? 'none'}</div>,
}));

vi.mock('../features/schedules/SchedulesPage', () => ({
  SchedulesPage: ({
    weekStart,
    focusScheduleId,
    invalidWeekStart,
  }: {
    weekStart?: string;
    focusScheduleId?: string;
    invalidWeekStart?: boolean;
  }) => (
    <div>
      Week: {weekStart ?? 'default'}; Focus: {focusScheduleId ?? 'none'}; Invalid: {String(Boolean(invalidWeekStart))}
    </div>
  ),
}));

vi.mock('../features/students', () => ({
  StudentsPage: ({ focusedStudentId }: { focusedStudentId?: string }) => (
    <div>Student focus: {focusedStudentId ?? 'none'}</div>
  ),
}));

vi.mock('../features/students/StudentDetailPage', () => ({
  StudentDetailPage: ({ studentId }: { studentId?: string }) => (
    <div>Student detail: {studentId ?? 'none'}</div>
  ),
}));

vi.mock('../features/daily-review', () => ({ DailyReviewPage: () => <div>Daily review</div> }));
vi.mock('../features/payments/PaymentsPage', () => ({ PaymentsPage: () => <div>Payments</div> }));
vi.mock('../features/llm-config', () => ({ LlmConfigPage: () => <div>LLM config page</div> }));
vi.mock('../features/privacy', () => ({ PrivacyPage: () => <div>Privacy page</div> }));

beforeEach(() => {
  sessionExpiredHandlers.length = 0;
  vi.mocked(authApi.me).mockResolvedValue(demoMe);
  vi.mocked(authApi.login).mockResolvedValue(undefined);
  vi.mocked(authApi.register).mockResolvedValue(undefined);
  vi.mocked(authApi.logout).mockResolvedValue(undefined);
});

describe('App A4 route consumption (authed)', () => {
  it('把合法focusMemo解码后传给Today页面', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入Today focus' }));

    expect(screen.getByText('Today focus: memo/1')).toBeInTheDocument();
  });

  it('非法focusMemo安全忽略', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入Today非法focus' }));

    expect(screen.getByText('Today focus: none')).toBeInTheDocument();
  });

  it('把合法weekStart和Schedule focus解码后传给SchedulesPage', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入显式周' }));

    expect(screen.getByText('Week: 2030-07-22; Focus: schedule/1; Invalid: false')).toBeInTheDocument();
  });

  it('非法weekStart传递显式错误标记而不静默回到默认周', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入非法周' }));

    expect(screen.getByText('Week: default; Focus: none; Invalid: true')).toBeInTheDocument();
  });

  it('把动态Student对象路径解码后传给学生详情页', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '进入学生对象' }));

    expect(screen.getByText('Student detail: student/1')).toBeInTheDocument();
  });

  it('authed 点击「LLM 配置」导航渲染 /settings/llm 页面', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '进入Today focus' });

    fireEvent.click(screen.getByRole('button', { name: 'LLM 配置' }));

    expect(await screen.findByText('LLM config page')).toBeInTheDocument();
  });

  it('authed 点击「隐私与数据」导航渲染 /settings/privacy 页面', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '进入Today focus' });

    fireEvent.click(screen.getByRole('button', { name: '隐私与数据' }));

    expect(await screen.findByText('Privacy page')).toBeInTheDocument();
  });
});

describe('App 路由守卫', () => {
  it('匿名访问受保护路由 → 渲染登录页且不渲染业务内容', async () => {
    vi.mocked(authApi.me).mockResolvedValue(null);

    render(<App />);

    await screen.findByRole('heading', { name: '登录' });
    expect(screen.queryByRole('button', { name: '进入Today focus' })).not.toBeInTheDocument();
  });

  it('loading 阶段渲染 AuthSplash 而非登录页', () => {
    vi.mocked(authApi.me).mockReturnValue(new Promise<MeData | null>(() => undefined));

    render(<App />);

    expect(screen.getByText('正在加载…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '登录' })).not.toBeInTheDocument();
  });

  it('业务 401（会话过期）→ 踢回登录页并提示「会话已过期」', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '进入Today focus' });

    act(() => {
      sessionExpiredHandlers[0]?.();
    });

    await screen.findByText('会话已过期，请重新登录');
    expect(screen.queryByRole('button', { name: '进入Today focus' })).not.toBeInTheDocument();
  });

  it('登录成功 → refresh 身份 → 回业务首页 /agent', async () => {
    vi.mocked(authApi.me).mockResolvedValueOnce(null).mockResolvedValue(demoMe);

    render(<App />);
    await screen.findByRole('heading', { name: '登录' });

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await screen.findByRole('button', { name: '进入Today focus' });
    expect(authApi.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' });
  });

  it('注册成功（/register 公开）→ 回业务首页 /agent', async () => {
    vi.mocked(authApi.me).mockResolvedValueOnce(null).mockResolvedValue(demoMe);

    render(<App />);
    await screen.findByRole('heading', { name: '登录' });
    fireEvent.click(screen.getByRole('button', { name: '去注册' }));
    await screen.findByRole('heading', { name: '注册' });

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '张三' } });
    fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await screen.findByRole('button', { name: '进入Today focus' });
    expect(authApi.register).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123', displayName: '张三' });
  });

  it('登出后回登录页（守卫：anon + 受保护路由 → /login）', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '进入Today focus' });

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    await screen.findByRole('heading', { name: '登录' });
    expect(authApi.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '进入Today focus' })).not.toBeInTheDocument();
  });

  it('authed 访问 /login → 重定向 /agent（公开路由不放行）', async () => {
    render(<App />);
    await screen.findByRole('button', { name: '进入Today focus' });

    fireEvent.click(screen.getByRole('button', { name: '进入登录页' }));

    // authed 时公开路由被守卫拉回业务首页：登录页不出现，业务内容保留
    await screen.findByRole('button', { name: '进入Today focus' });
    expect(screen.queryByRole('heading', { name: '登录' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '注册' })).not.toBeInTheDocument();
  });
});
