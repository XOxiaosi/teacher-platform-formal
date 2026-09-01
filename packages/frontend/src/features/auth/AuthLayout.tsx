import type { ReactNode } from 'react';
import './auth.css';

interface AuthLayoutProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** 登录/注册共用外壳：品牌区 + 居中卡片，在 AppShell 之外渲染（不暴露受保护导航）。 */
export function AuthLayout({ eyebrow, title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="auth-shell">
      <div className="auth-brand" role="banner">
        <div className="brand-mark" aria-hidden="true">物</div>
        <div className="brand-copy">
          <p className="eyebrow">教学工作台</p>
          <h1>教师 AI 工具平台</h1>
        </div>
      </div>
      <section className="auth-card page-card" aria-label={title}>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="auth-subtitle">{subtitle}</p>
        {children}
      </section>
    </div>
  );
}
