import { useState, type FormEvent } from 'react';
import { useAdminAuth } from '../app/admin-auth-context';
import '../styles/admin.css';

interface AdminLoginPageProps {
  /** 登录成功（身份 refresh 完成）后跳转总览。 */
  onSuccess: () => void;
}

/**
 * 管理员登录页（/admin/login）：邮箱 + 密码 → POST /api/v1/admin/auth/login。
 * adminToken cookie 由后端 Set-Cookie（HttpOnly; SameSite=Lax; Path=/，生产 Secure）。
 */
export function AdminLoginPage({ onSuccess }: AdminLoginPageProps) {
  const { login, error: contextError } = useAdminAuth();
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
      onSuccess();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-shell">
      <div className="admin-brand" role="banner">
        <div className="brand-mark" aria-hidden="true">管</div>
        <div className="brand-copy">
          <p className="eyebrow">后台管理</p>
          <h1>教师 AI 工具平台</h1>
        </div>
      </div>
      <section className="admin-card page-card" aria-label="管理员登录">
        <p className="eyebrow">后台管理 · 登录</p>
        <h2>管理员登录</h2>
        <p className="admin-subtitle">使用管理员账号登录后台管理系统。</p>
        <form className="admin-form" onSubmit={handleSubmit}>
          <label htmlFor="admin-email">
            邮箱
            <input
              id="admin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label htmlFor="admin-password">
            密码
            <input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {contextError ? <p className="admin-error" role="alert">{contextError}</p> : null}
          {error ? <p className="admin-error" role="alert">登录失败：{error}</p> : null}
          <button className="primary-action" type="submit" disabled={!canSubmit}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      </section>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
