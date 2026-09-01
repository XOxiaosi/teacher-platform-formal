import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import * as adminAuthApi from '../api/adminAuth';
import { AdminAuthProvider } from '../app/admin-auth-context';
import { AdminLoginPage } from './AdminLoginPage';

vi.mock('../api/adminAuth');

function renderLoginPage(onSuccess: () => void = () => undefined) {
  return render(
    <AdminAuthProvider>
      <AdminLoginPage onSuccess={onSuccess} />
    </AdminAuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(adminAuthApi.me).mockReset().mockResolvedValue(null); // 未登录
  vi.mocked(adminAuthApi.login).mockReset().mockResolvedValue(undefined);
  vi.mocked(adminAuthApi.logout).mockReset().mockResolvedValue(undefined);
});

describe('AdminLoginPage', () => {
  it('渲染邮箱/密码/登录按钮', async () => {
    renderLoginPage();

    expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('空提交禁用按钮，不调用 login', async () => {
    renderLoginPage();
    await screen.findByLabelText('邮箱');

    const submit = screen.getByRole('button', { name: '登录' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(adminAuthApi.login).not.toHaveBeenCalled();
  });

  it('登录失败展示 role=alert 错误条且不清空表单', async () => {
    vi.mocked(adminAuthApi.login).mockRejectedValue(
      new ApiError({ code: 'PERMISSION_DENIED', message: '邮箱或密码错误' }, 401),
    );
    renderLoginPage();
    await screen.findByLabelText('邮箱');

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('登录失败：邮箱或密码错误');
    expect(screen.getByLabelText('邮箱')).toHaveValue('admin@example.com');
  });

  it('登录成功：调用 login 并 refresh 身份后触发 onSuccess', async () => {
    const onSuccess = vi.fn();
    vi.mocked(adminAuthApi.me)
      .mockResolvedValueOnce(null) // 挂载
      .mockResolvedValue({ email: 'admin@example.com' }); // 登录后 refresh
    renderLoginPage(onSuccess);
    await screen.findByLabelText('邮箱');

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(adminAuthApi.login).toHaveBeenCalledWith({
      email: 'admin@example.com',
      password: 'secret123',
    }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });
});
