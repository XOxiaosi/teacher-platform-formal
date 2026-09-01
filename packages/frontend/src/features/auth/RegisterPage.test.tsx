import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import * as authApi from '../../api/auth';
import { RegisterPage } from './RegisterPage';

vi.mock('../../api/auth');

const VALID = {
  email: 'a@b.com',
  displayName: '张三',
  password: 'secret123',
  confirmPassword: 'secret123',
};

function fillValidForm() {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: VALID.email } });
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: VALID.displayName } });
  fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: VALID.password } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: VALID.confirmPassword } });
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.mocked(authApi.register).mockReset();
  });

  it('渲染邮箱、昵称、密码、确认密码与注册按钮', () => {
    render(<RegisterPage onNavigate={() => undefined} />);

    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('昵称')).toBeInTheDocument();
    expect(screen.getByLabelText('密码（至少 8 位）')).toBeInTheDocument();
    expect(screen.getByLabelText('确认密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去登录' })).toBeInTheDocument();
  });

  it('邮箱格式非法时展示字段错误且不调用 register', () => {
    render(<RegisterPage onNavigate={() => undefined} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: VALID.displayName } });
    fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: VALID.password } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: VALID.confirmPassword } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(screen.getByRole('alert')).toHaveTextContent('邮箱格式不正确');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('密码不足 8 位时展示字段错误', () => {
    render(<RegisterPage onNavigate={() => undefined} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: VALID.email } });
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: VALID.displayName } });
    fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(screen.getByRole('alert')).toHaveTextContent('密码至少 8 位');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('两次密码不一致时展示字段错误', () => {
    render(<RegisterPage onNavigate={() => undefined} />);
    fillValidForm();
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'different9' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(screen.getByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('昵称为空时展示字段错误且不调用 register', () => {
    render(<RegisterPage onNavigate={() => undefined} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: VALID.email } });
    fireEvent.change(screen.getByLabelText('密码（至少 8 位）'), { target: { value: VALID.password } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: VALID.confirmPassword } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(screen.getByRole('alert')).toHaveTextContent('请输入昵称');
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('合法提交调用 register（body 不含确认密码）并进入 loading，完成后恢复', async () => {
    let resolveRegister: () => void = () => undefined;
    vi.mocked(authApi.register).mockReturnValue(new Promise<void>((resolve) => { resolveRegister = resolve; }));

    render(<RegisterPage onNavigate={() => undefined} />);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(authApi.register).toHaveBeenCalledWith({
      email: VALID.email,
      password: VALID.password,
      displayName: VALID.displayName,
    });
    expect(screen.getByRole('button', { name: '注册中…' })).toBeDisabled();

    resolveRegister();
    await waitFor(() => expect(screen.getByRole('button', { name: '注册' })).toBeEnabled());
  });

  it('服务端错误展示 role=alert 错误条', async () => {
    vi.mocked(authApi.register).mockRejectedValue(new ApiError({ code: 'VALIDATION_ERROR', message: '邮箱已被注册' }));

    render(<RegisterPage onNavigate={() => undefined} />);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('注册失败：邮箱已被注册');
  });

  it('「去登录」切到 /login', () => {
    const onNavigate = vi.fn();
    render(<RegisterPage onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: '去登录' }));

    expect(onNavigate).toHaveBeenCalledWith('/login');
  });
});
