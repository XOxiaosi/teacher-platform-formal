import { useAdminAuth } from './admin-auth-context';
import '../styles/admin.css';

export interface AdminNavItem {
  key: 'overview' | 'teachers' | 'feedback' | 'usage' | 'health';
  label: string;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { key: 'overview', label: '总览' },
  { key: 'teachers', label: '教师总览' },
  { key: 'feedback', label: '反馈看板' },
  { key: 'usage', label: '用量费用' },
  { key: 'health', label: '系统健康' },
];

interface AdminShellProps {
  active: AdminNavItem['key'];
  onNavigate: (key: AdminNavItem['key']) => void;
  children: React.ReactNode;
}

/** 后台管理外壳：顶栏品牌 + 主导航 + 管理员身份/退出；页面内容渲染在下方。 */
export function AdminShell({ active, onNavigate, children }: AdminShellProps) {
  const { email, logout } = useAdminAuth();
  return (
    <div className="admin-shell-frame">
      <header className="admin-topbar">
        <div className="admin-topbar-brand">
          <div className="brand-mark" aria-hidden="true">管</div>
          <div>
            <p className="eyebrow">后台管理</p>
            <h1>教师 AI 工具平台</h1>
          </div>
        </div>
        <nav className="admin-topbar-nav" aria-label="后台主导航">
          {ADMIN_NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={active === item.key ? 'admin-nav-item active' : 'admin-nav-item'}
              aria-current={active === item.key ? 'page' : undefined}
              onClick={() => onNavigate(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="admin-identity">
          {email ?? '管理员'} · <button type="button" onClick={() => void logout()}>退出登录</button>
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  );
}
