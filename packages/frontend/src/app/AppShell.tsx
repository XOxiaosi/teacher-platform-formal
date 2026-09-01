import { useEffect, useRef, type ReactNode } from 'react';
import { auxiliaryRoutes, primaryRoutes, routePathname, type AppRoute } from './routes';
import { useAuth } from './teacher-context';

interface AppShellProps {
  currentRoute: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}

interface NavigationProps {
  label: string;
  routes: AppRoute[];
  currentRoute: string;
  onNavigate: (path: string) => void;
  className?: string;
}

function Navigation({ label, routes, currentRoute, onNavigate, className }: NavigationProps) {
  const activePath = routePathname(currentRoute);
  return (
    <nav className={className} aria-label={label}>
      {routes.map((route) => {
        const active = route.path === activePath;
        return (
          <button
            key={route.path}
            className={active ? 'nav-item active' : 'nav-item'}
            type="button"
            aria-current={active ? 'page' : undefined}
            title={route.label}
            onClick={() => onNavigate(route.path)}
          >
            <span className="nav-mark" aria-hidden="true">{route.shortLabel.slice(0, 1)}</span>
            <span className="nav-label">{route.label}</span>
            <span className="nav-short-label" aria-hidden="true">{route.shortLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function AppShell({ currentRoute, onNavigate, children }: AppShellProps) {
  const { displayName, logout } = useAuth();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus();
  }, [currentRoute]);

  return (
    <div className="app-shell">
      <div className="desktop-width-warning" role="status">请使用至少 1180px 宽度的桌面窗口</div>
      <aside className="sidebar">
        <header className="app-header" role="banner">
          <div className="brand-mark" aria-hidden="true">物</div>
          <div className="brand-copy">
            <p className="eyebrow">教学工作台</p>
            <h1>教师 AI 工具平台</h1>
          </div>
        </header>

        <Navigation
          label="主导航"
          routes={primaryRoutes}
          currentRoute={currentRoute}
          onNavigate={onNavigate}
          className="primary-navigation"
        />
        <Navigation
          label="辅助导航"
          routes={auxiliaryRoutes}
          currentRoute={currentRoute}
          onNavigate={onNavigate}
          className="auxiliary-navigation"
        />

        <div className="teacher-pill">
          <span className="teacher-pill-name">{displayName ?? '当前老师'}</span>
          <button type="button" className="teacher-pill-logout" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>

      <main ref={mainRef} className="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
