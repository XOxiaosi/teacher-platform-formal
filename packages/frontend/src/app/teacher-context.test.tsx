import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeacherProvider, useAuth } from './teacher-context';
import * as authApi from '../api/auth';
import { readCaptureDraft, writeCaptureDraft } from '../connected/captures/drafts';
import type { MeData } from '../api/auth';

vi.mock('../api/auth');

// TeacherProvider 挂载时注册 onSessionExpired；捕获以便在用例里触发「会话过期」
const { sessionExpiredHandlers } = vi.hoisted(() => ({ sessionExpiredHandlers: [] as Array<() => void> }));

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

const demoMe: MeData = { id: 'teacher-1', email: 'a@b.com', displayName: '张三' };

function Probe() {
  const { status, teacherId, email, displayName, error } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="teacherId">{teacherId ?? ''}</span>
      <span data-testid="email">{email ?? ''}</span>
      <span data-testid="displayName">{displayName ?? ''}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionExpiredHandlers.length = 0;
});

describe('TeacherProvider session 化', () => {
  it('初始 loading，me 200 后转 authed 并填充身份', async () => {
    vi.mocked(authApi.me).mockResolvedValue(demoMe);

    render(<TeacherProvider><Probe /></TeacherProvider>);

    expect(screen.getByTestId('status')).toHaveTextContent('loading');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));
    expect(screen.getByTestId('teacherId')).toHaveTextContent('teacher-1');
    expect(screen.getByTestId('email')).toHaveTextContent('a@b.com');
    expect(screen.getByTestId('displayName')).toHaveTextContent('张三');
  });

  it('me 401（null）转 anon，身份为空、无错误', async () => {
    vi.mocked(authApi.me).mockResolvedValue(null);

    render(<TeacherProvider><Probe /></TeacherProvider>);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));
    expect(screen.getByTestId('teacherId')).toHaveTextContent('');
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('首次匿名 me 401 触发全局回调时不显示会话过期', async () => {
    vi.mocked(authApi.me).mockResolvedValue(null);

    render(<TeacherProvider><Probe /></TeacherProvider>);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));
    act(() => { sessionExpiredHandlers[0]?.(); });

    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('me 网络失败转 anon 并带可重试错误文案', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new Error('network down'));

    render(<TeacherProvider><Probe /></TeacherProvider>);

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));
    expect(screen.getByTestId('error').textContent).toContain('无法连接服务器');
  });

  it('refresh 重新拉取身份并从 anon 转 authed', async () => {
    vi.mocked(authApi.me).mockResolvedValue(null);

    function RefreshProbe() {
      const { refresh } = useAuth();
      return (
        <div>
          <Probe />
          <button type="button" onClick={() => void refresh()}>刷新</button>
        </div>
      );
    }

    render(<TeacherProvider><RefreshProbe /></TeacherProvider>);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));

    vi.mocked(authApi.me).mockResolvedValue(demoMe);
    screen.getByRole('button', { name: '刷新' }).click();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));
    expect(screen.getByTestId('teacherId')).toHaveTextContent('teacher-1');
  });

  it('logout 调用 auth logout 并转 anon（best-effort）', async () => {
    vi.mocked(authApi.me).mockResolvedValue(demoMe);
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    writeCaptureDraft('teacher-1', 'event', 'candidate', { generation: 'g1', text: '甲的材料草稿', studentId: '', baseVersion: 1 });
    writeCaptureDraft('teacher-2', 'event', 'candidate', { generation: 'g2', text: '乙的材料草稿', studentId: '', baseVersion: 1 });

    function LogoutProbe() {
      const { logout } = useAuth();
      return (
        <div>
          <Probe />
          <button type="button" onClick={() => void logout()}>退出</button>
        </div>
      );
    }

    render(<TeacherProvider><LogoutProbe /></TeacherProvider>);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));

    screen.getByRole('button', { name: '退出' }).click();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));
    expect(authApi.logout).toHaveBeenCalledTimes(1);
    expect(readCaptureDraft('teacher-1', 'event', 'candidate')).toBeUndefined();
    expect(readCaptureDraft('teacher-2', 'event', 'candidate')?.text).toBe('乙的材料草稿');
  });

  it('logout 请求失败保留 authed 并带错误，不伪装已退出', async () => {
    vi.mocked(authApi.me).mockResolvedValue(demoMe);
    vi.mocked(authApi.logout).mockRejectedValue(new Error('network down'));

    function LogoutProbe() {
      const { logout } = useAuth();
      return (
        <div>
          <Probe />
          <button type="button" onClick={() => void logout()}>退出</button>
        </div>
      );
    }

    render(<TeacherProvider><LogoutProbe /></TeacherProvider>);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));

    screen.getByRole('button', { name: '退出' }).click();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));
    expect(screen.getByTestId('teacherId')).toHaveTextContent('teacher-1');
    expect(screen.getByTestId('error')).toHaveTextContent('退出登录失败');
  });

  it('业务 401 全局回调（onSessionExpired）→ anon + 「会话已过期，请重新登录」', async () => {
    vi.mocked(authApi.me).mockResolvedValue(demoMe);

    render(<TeacherProvider><Probe /></TeacherProvider>);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authed'));

    act(() => {
      sessionExpiredHandlers[0]?.();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anon'));
    expect(screen.getByTestId('teacherId')).toHaveTextContent('');
    expect(screen.getByTestId('error')).toHaveTextContent('会话已过期，请重新登录');
  });
});
