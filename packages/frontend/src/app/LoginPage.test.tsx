import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage, localInitialLogin } from './LoginPage';
import { login } from '../api/auth';

vi.mock('../api/auth', () => ({ login: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('local initial login', () => {
  it('allows the alias only in a development build on loopback', () => {
    expect(localInitialLogin(true,'127.0.0.1')).toBe(true);
    expect(localInitialLogin(true,'localhost')).toBe(true);
    expect(localInitialLogin(false,'127.0.0.1')).toBe(false);
    expect(localInitialLogin(true,'teacher.example.com')).toBe(false);
    expect(localInitialLogin(true,'localhost.example.com')).toBe(false);
  });
  it('submits 123 through normal password authentication, not an auto-login bypass', async () => {
    vi.stubEnv('DEV', true);
    vi.mocked(login).mockResolvedValue(undefined);
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<LoginPage onRetry={onRetry} />);
    fireEvent.change(screen.getByLabelText('账号或邮箱'), {target:{value:'123'}});
    fireEvent.change(screen.getByLabelText('密码'), {target:{value:'123'}});
    fireEvent.click(screen.getByRole('button',{name:'登录'}));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    expect(login).toHaveBeenCalledWith({email:'123@example.test',password:'123'});
  });
  it('production keeps email-only login and does not show the local alias input', () => {
    vi.stubEnv('DEV', false);
    render(<LoginPage onRetry={vi.fn()} />);
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('type','email');
    expect(screen.queryByLabelText('账号或邮箱')).toBeNull();
  });
});
