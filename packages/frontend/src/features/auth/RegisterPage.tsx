import { useState, type FormEvent } from 'react';
import { register } from '../../api/auth';
import { useAuth } from '../../app/teacher-context';
import { AuthLayout } from './AuthLayout';
import './auth.css';

interface RegisterPageProps {
  onNavigate: (path: string) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** 注册页：邮箱 + 昵称 + 密码（+本地确认密码）→ POST /auth/register（Set-Cookie sessionToken）。 */
export function RegisterPage({ onNavigate }: RegisterPageProps) {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldError = validate(email, displayName, password, confirmPassword);
  const canSubmit = fieldError === null && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      await register({ email: email.trim(), password, displayName: displayName.trim() });
      // 注册成功 → refresh 身份；AppContent 路由守卫负责跳到业务首页
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout eyebrow="教学工作台 · 注册" title="注册" subtitle="创建账号，开始使用教学工作台。">
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <label htmlFor="register-email">
          邮箱
          <input
            id="register-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label htmlFor="register-display-name">
          昵称
          <input
            id="register-display-name"
            type="text"
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label htmlFor="register-password">
          密码（至少 {MIN_PASSWORD_LENGTH} 位）
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label htmlFor="register-confirm-password">
          确认密码
          <input
            id="register-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        {fieldError ? (
          <p className="auth-error" role="alert">{fieldError}</p>
        ) : null}
        {error ? (
          <p className="auth-error" role="alert">注册失败：{error}</p>
        ) : null}
        <button className="primary-action" type="submit" disabled={!canSubmit}>
          {submitting ? '注册中…' : '注册'}
        </button>
      </form>
      <p className="auth-switch">
        已有账号？{' '}
        <button type="button" className="auth-switch-link" onClick={() => onNavigate('/login')}>
          去登录
        </button>
      </p>
    </AuthLayout>
  );
}

function validate(email: string, displayName: string, password: string, confirmPassword: string): string | null {
  if (!email.trim()) return '请输入邮箱';
  if (!EMAIL_PATTERN.test(email.trim())) return '邮箱格式不正确';
  if (!displayName.trim()) return '请输入昵称';
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (password !== confirmPassword) return '两次输入的密码不一致';
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
