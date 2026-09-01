import { useEffect, useState } from 'react';
import { AgentPage } from '../features/agent';
import { DailyReviewPage } from '../features/daily-review';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { FeedbackPage } from '../features/feedback';
import { PaymentsPage } from '../features/payments/PaymentsPage';
import { SchedulesPage } from '../features/schedules/SchedulesPage';
import { StudentDetailPage } from '../features/students/StudentDetailPage';
import { StudentsPage } from '../features/students';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { LlmConfigPage } from '../features/llm-config';
import { PrivacyPage } from '../features/privacy';
import { UserFeedbackPage } from '../features/user-feedback/UserFeedbackPage';
import { AppShell } from './AppShell';
import {
  isPublicRoute,
  parseSingleRouteQuery,
  parseStudentRouteId,
  parseWeekStartRouteQuery,
  resolveAppRoute,
  routePathname,
} from './routes';
import { TeacherProvider, useAuth } from './teacher-context';

const pageTitles: Record<string, { title: string; description: string }> = {
  '/feedback': { title: '家长反馈', description: '集中查看、整理和跟进家长沟通。' },
  '/changelog': { title: '变更记录', description: '追溯 Agent 与人工操作留下的业务变化。' },
  '/settings': { title: '设置', description: '管理当前可信本地环境的工作台设置。' },
};

export function App() {
  return (
    <TeacherProvider>
      <AppContent />
    </TeacherProvider>
  );
}

function AppContent() {
  const [route, setRoute] = useState('/agent');
  const [redirectAfterLogin, setRedirectAfterLogin] = useState<string | null>(null);
  const { status, teacherId } = useAuth();
  const navigate = (path: string) => setRoute(resolveAppRoute(path));

  // 路由守卫：匿名访问受保护页 → /login，并记下登录后回跳目标
  useEffect(() => {
    if (status !== 'anon' || isPublicRoute(route)) return;
    setRedirectAfterLogin(route);
    setRoute('/login');
  }, [status, route]);

  // 已登录访问公开页（/login /register）→ 回业务首页（默认兜底）
  useEffect(() => {
    if (status !== 'authed' || !isPublicRoute(route)) return;
    setRoute('/agent');
  }, [status, route]);

  // 登录成功 → 回跳 redirectAfterLogin（声明在后，优先级高于公开页兜底）
  useEffect(() => {
    if (status !== 'authed' || redirectAfterLogin === null) return;
    const target = redirectAfterLogin;
    setRedirectAfterLogin(null);
    setRoute(target);
  }, [status, redirectAfterLogin]);

  if (status === 'loading') {
    return (
      <div className="auth-shell" role="status">
        <div className="auth-brand">
          <div className="brand-mark" aria-hidden="true">物</div>
          <p className="eyebrow">教学工作台</p>
        </div>
        <p>正在加载…</p>
      </div>
    );
  }

  if (status === 'anon') {
    const pathname = routePathname(route);
    if (pathname === '/register') {
      return <RegisterPage onNavigate={navigate} />;
    }
    return <LoginPage onNavigate={navigate} />;
  }

  if (teacherId === null) {
    return <LoginPage onNavigate={navigate} />;
  }

  // authed：AppShell + 业务页面（teacherId 已非空收窄，业务页面签名保持 string）
  return (
    <AppShell currentRoute={route} onNavigate={navigate}>
      {renderPage(route, teacherId, navigate)}
    </AppShell>
  );
}

function renderPage(route: string, teacherId: string, onNavigate: (path: string) => void) {
  const pathname = routePathname(route);
  if (pathname === '/agent') return <AgentPage teacherId={teacherId} onNavigate={onNavigate} />;
  if (pathname === '/today' && route.includes('view=review')) return <DailyReviewPage teacherId={teacherId} />;
  if (pathname === '/today') {
    const focusMemo = validRouteValue(parseSingleRouteQuery(route, 'focusMemo'));
    return <DashboardPage teacherId={teacherId} focusMemo={focusMemo} onNavigate={onNavigate} />;
  }

  const studentRoute = parseStudentRouteId(route);
  if (studentRoute.kind === 'valid') {
    return (
      <StudentDetailPage
        teacherId={teacherId}
        studentId={studentRoute.value}
        onNavigate={onNavigate}
      />
    );
  }
  if (pathname === '/students') {
    return <StudentsPage teacherId={teacherId} onNavigate={onNavigate} />;
  }

  if (pathname === '/schedules') {
    const weekStart = parseWeekStartRouteQuery(route);
    const focusSchedule = parseSingleRouteQuery(route, 'focus');
    return (
      <SchedulesPage
        teacherId={teacherId}
        weekStart={weekStart.kind === 'valid' ? weekStart.value : undefined}
        invalidWeekStart={weekStart.kind === 'invalid'}
        focusScheduleId={validRouteValue(focusSchedule)}
        onNavigate={onNavigate}
      />
    );
  }
  if (pathname === '/finance') return <PaymentsPage teacherId={teacherId} />;
  if (pathname === '/feedback') return <FeedbackPage teacherId={teacherId} />;
  if (pathname === '/feedback-submit') return <UserFeedbackPage teacherId={teacherId} />;
  if (pathname === '/settings/llm') return <LlmConfigPage teacherId={teacherId} />;
  if (pathname === '/settings/privacy') return <PrivacyPage teacherId={teacherId} />;

  const page = pageTitles[pathname] ?? pageTitles['/settings'];
  return (
    <section className="page-card">
      <p className="eyebrow">当前页面</p>
      <h2>{page.title}</h2>
      <p>{page.description}</p>
    </section>
  );
}

function validRouteValue(parsed: ReturnType<typeof parseSingleRouteQuery>): string | undefined {
  return parsed.kind === 'valid' ? parsed.value : undefined;
}
