import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAuth } from './teacher-context';
import * as authApi from '../api/auth';
import type { MeData } from '../api/auth';

vi.mock('../api/auth');
vi.mock('../connected/ConnectedWorkspace', () => ({
  ConnectedWorkspace: () => {
    const auth = useAuth();
    const [mountedFor] = useState(auth.teacherId);
    return <main><h1>欢迎回来，{auth.displayName}</h1><p data-testid="workspace-mounted-for">{mountedFor}</p><button type="button" onClick={() => void auth.refresh()}>刷新身份</button><button type="button" onClick={() => void auth.logout()}>退出登录</button>{auth.error && <p role="alert">{auth.error}</p>}</main>;
  },
}));

const demoMe: MeData = { id: 'teacher-1', email: 'teacher@example.com', displayName: '张老师' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('认证壳', () => {
  it('恢复会话期间显示加载状态，不加载业务工作区', () => {
    vi.mocked(authApi.me).mockReturnValue(new Promise<MeData | null>(() => undefined));

    render(<App />);

    expect(screen.getByText('正在恢复登录状态…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /欢迎回来/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '开启今天的教学工作' })).not.toBeInTheDocument();
  });

  it('服务不可用时显示可重试错误，重试成功后进入登录态', async () => {
    vi.mocked(authApi.me).mockRejectedValueOnce(new Error('network down')).mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接服务器');
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '开启今天的教学工作' })).toBeInTheDocument());
    expect(authApi.me).toHaveBeenCalledTimes(2);
  });

  it('登录失败显示错误且不加载业务工作区', async () => {
    vi.mocked(authApi.me).mockResolvedValue(null);
    vi.mocked(authApi.login).mockRejectedValue(new Error('邮箱或密码不正确'));
    render(<App />);

    await screen.findByRole('heading', { name: '开启今天的教学工作' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'teacher@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('邮箱或密码不正确');
    expect(screen.getByLabelText('邮箱')).toHaveValue('teacher@example.com');
    expect(screen.getByLabelText('密码')).toHaveValue('wrong-password');
    expect(screen.queryByRole('heading', { name: /欢迎回来/ })).not.toBeInTheDocument();
  });

  it('登录成功后重新读取会话并进入受保护工作区', async () => {
    vi.mocked(authApi.me).mockResolvedValueOnce(null).mockResolvedValue(demoMe);
    vi.mocked(authApi.login).mockResolvedValue(undefined);
    render(<App />);

    await screen.findByRole('heading', { name: '开启今天的教学工作' });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: ' teacher@example.com ' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '欢迎回来，张老师' })).toBeInTheDocument();
    expect(authApi.login).toHaveBeenCalledWith({ email: 'teacher@example.com', password: 'correct-password' });
  });

  it('教师身份变化时重新挂载工作区，避免沿用旧教师草稿', async () => {
    const secondTeacher: MeData = { id: 'teacher-2', email: 'second@example.com', displayName: '李老师' };
    vi.mocked(authApi.me).mockResolvedValueOnce(demoMe).mockResolvedValue(secondTeacher);
    render(<App />);

    await screen.findByRole('heading', { name: '欢迎回来，张老师' });
    expect(screen.getByTestId('workspace-mounted-for')).toHaveTextContent('teacher-1');
    fireEvent.click(screen.getByRole('button', { name: '刷新身份' }));

    await screen.findByRole('heading', { name: '欢迎回来，李老师' });
    expect(screen.getByTestId('workspace-mounted-for')).toHaveTextContent('teacher-2');
  });

  it('退出失败保留受保护工作区并提示错误', async () => {
    vi.mocked(authApi.me).mockResolvedValue(demoMe);
    vi.mocked(authApi.logout).mockRejectedValue(new Error('network down'));
    render(<App />);

    await screen.findByRole('heading', { name: '欢迎回来，张老师' });
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('退出登录失败');
    expect(screen.getByRole('heading', { name: '欢迎回来，张老师' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '开启今天的教学工作' })).not.toBeInTheDocument();
  });
});
