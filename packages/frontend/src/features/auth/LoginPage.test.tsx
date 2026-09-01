import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import * as authApi from '../../api/auth';
import { TeacherProvider } from '../../app/teacher-context';
import { LoginPage } from './LoginPage';

vi.mock('../../api/auth');

describe('LoginPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.login).mockReset();
    vi.mocked(authApi.me).mockReset();
  });

  it('渲染邮箱、密码、登录按钮与「去注册」入口', () => {
    render(<LoginPage onNavigate={() => undefined} />);

    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去注册' })).toBeInTheDocument();
  });

  it('空提交不调用 login', () => {
    render(<LoginPage onNavigate={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('仅邮箱非空、密码空 → 提交按钮 disabled（登录页只有非空门槛）', () => {
    render(<LoginPage onNavigate={() => undefined} />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.com' } });

    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('合法提交调用 login（body 正确）并进入 loading，完成后恢复', async () => {
    let resolveLogin: () => void = () => undefined;
    vi.mocked(authApi.login).mockReturnValue(new Promise<void>((resolve) => { resolveLogin = resolve; }));

    render(<LoginPage onNavigate={() => undefined} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(authApi.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' });
    expect(screen.getByRole('button', { name: '登录中…' })).toBeDisabled();

    resolveLogin();
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeEnabled());
  });

  it('登录失败展示 role=alert 错误条且不清空已填内容', async () => {
    vi.mocked(authApi.login).mockRejectedValue(new ApiError({ code: 'VALIDATION_ERROR', message: '邮箱或密码错误' }));

    render(<LoginPage onNavigate={() => undefined} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('登录失败：邮箱或密码错误');
    expect(screen.getByLabelText('邮箱')).toHaveValue('a@b.com');
    expect(screen.getByLabelText('密码')).toHaveValue('secret123');
  });

  it('「去注册」切到 /register', () => {
    const onNavigate = vi.fn();
    render(<LoginPage onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: '去注册' }));

    expect(onNavigate).toHaveBeenCalledWith('/register');
  });

  it('键盘可达性：label 关联 + autocomplete + type 正确', () => {
    render(<LoginPage onNavigate={() => undefined} />);

    expect(screen.getByLabelText('邮箱')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('密码')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('密码')).toHaveAttribute('type', 'password');
  });

  it('展示 context 错误（/me 网络失败）并提供「重试」→ refresh', async () => {
    vi.mocked(authApi.me).mockRejectedValue(new Error('network down'));

    render(
      <TeacherProvider>
        <LoginPage onNavigate={() => undefined} />
      </TeacherProvider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('无法连接服务器');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(2));
  });
});
