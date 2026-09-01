import { useState, type FormEvent } from 'react';
import { login } from '../../api/auth';
import { useAuth } from '../../app/teacher-context';
import { AuthLayout } from './AuthLayout';
import './auth.css';

interface LoginPageProps {
  onNavigate: (path: string) => void;
}

/** 登录页：邮箱 + 密码 → POST /auth/login（Set-Cookie sessionToken）。 */
export function LoginPage({ onNavigate }: LoginPageProps) {
  const { refresh, error: contextError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await login({ email: email.trim(), password });
      // 登录成功 → refresh 身份；AppContent 路由守卫负责跳转（回跳 redirectAfterLogin）
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout eyebrow="教学工作台 · 登录" title="登录" subtitle="使用邮箱和密码登录教学工作台。">
      <form className="auth-form" onSubmit={handleSubmit}>
        <label htmlFor="login-email">
          邮箱
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label htmlFor="login-password">
          密码
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {contextError ? (
          <p className="auth-error" role="alert">
            {contextError}{' '}
            <button type="button" className="auth-switch-link" onClick={() => void refresh()}>重试</button>
          </p>
        ) : null}
        {error ? (
          <p className="auth-error" role="alert">登录失败：{error}</p>
        ) : null}
        <button className="primary-action" type="submit" disabled={!canSubmit}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
      <p className="auth-switch">
        还没有账号？{' '}
        <button type="button" className="auth-switch-link" onClick={() => onNavigate('/register')}>
          去注册
        </button>
      </p>
    </AuthLayout>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
