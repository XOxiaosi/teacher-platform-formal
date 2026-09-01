import { useEffect, useState } from 'react';
import { AdminAuthProvider, useAdminAuth } from './admin-auth-context';
import { AdminShell, type AdminNavItem } from './AdminShell';
import { AdminLoginPage } from '../pages/AdminLoginPage';
import { OverviewPlaceholder } from '../pages/OverviewPlaceholder';
import { TeachersPage } from '../pages/TeachersPage';
import { TeacherDetailPage } from '../pages/TeacherDetailPage';
import { FeedbackBoardPage } from '../pages/FeedbackBoardPage';
import { AdminUsagePage } from '../pages/AdminUsagePage';
import { HealthPage } from '../pages/HealthPage';

/**
 * 后台管理根组件（packages/admin，state-based 路由，与教师端同风格无 react-router）。
 * 路由语义：
 *   /admin 根 → status 三态：loading → 加载态；anon → 登录页（守卫重定向）；
 *   authed → 顶栏外壳 + 页面（总览 / 教师总览 / 教师详情 / 反馈看板）。
 * 登录成功 → 总览；未登录访问任何受保护页 → 登录页。
 */
export function App() {
  return (
    <AdminAuthProvider>
      <AdminAppContent />
    </AdminAuthProvider>
  );
}

type AdminRoute =
  | { kind: 'login' }
  | { kind: 'page'; page: AdminNavItem['key'] }
  | { kind: 'teacher-detail'; teacherId: string };

function AdminAppContent() {
  const { status } = useAdminAuth();
  const [route, setRoute] = useState<AdminRoute>({ kind: 'page', page: 'overview' });

  const navigate = (page: AdminNavItem['key']) => setRoute({ kind: 'page', page });

  // 路由守卫：anon + 受保护页 → 登录页
  useEffect(() => {
    if (status === 'anon' && route.kind !== 'login') {
      setRoute({ kind: 'login' });
    }
  }, [status, route]);

  // authed 访问登录页 → 回总览
  useEffect(() => {
    if (status === 'authed' && route.kind === 'login') {
      setRoute({ kind: 'page', page: 'overview' });
    }
  }, [status, route]);

  if (status === 'loading') {
    return (
      <div className="admin-shell" role="status">
        <div className="admin-brand">
          <div className="brand-mark" aria-hidden="true">管</div>
          <p className="eyebrow">后台管理</p>
        </div>
        <p>正在加载…</p>
      </div>
    );
  }

  if (status === 'anon' || route.kind === 'login') {
    return <AdminLoginPage onSuccess={() => setRoute({ kind: 'page', page: 'overview' })} />;
  }

  if (route.kind === 'teacher-detail') {
    return (
      <AdminShell active="teachers" onNavigate={navigate}>
        <TeacherDetailPage
          teacherId={route.teacherId}
          onBack={() => navigate('teachers')}
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell active={route.page} onNavigate={navigate}>
      {route.page === 'overview' ? <OverviewPlaceholder /> : null}
      {route.page === 'teachers' ? (
        <TeachersPage onSelectTeacher={(teacherId) => setRoute({ kind: 'teacher-detail', teacherId })} />
      ) : null}
      {route.page === 'feedback' ? <FeedbackBoardPage /> : null}
      {route.page === 'usage' ? <AdminUsagePage /> : null}
      {route.page === 'health' ? <HealthPage /> : null}
    </AdminShell>
  );
}
