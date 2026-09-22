import { useEffect, useState } from 'react';
import { useAuth, TeacherProvider } from './teacher-context';
import { LoginPage } from './LoginPage';
import { AcceptInvitationPage } from './AcceptInvitationPage';
import { ConnectedWorkspace } from '../connected/ConnectedWorkspace';
import './auth-shell.css';

export function App() { return <TeacherProvider><AuthGate /></TeacherProvider>; }

function AuthGate() {
  const auth = useAuth();
  const [isInvitationRoute, setIsInvitationRoute] = useState(isAcceptInvitationRoute);
  useEffect(() => {
    const syncRoute = () => setIsInvitationRoute(isAcceptInvitationRoute());
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => { window.removeEventListener('popstate', syncRoute); window.removeEventListener('hashchange', syncRoute); };
  }, []);
  if (isInvitationRoute) {
    return <AcceptInvitationPage onAccepted={async () => { await auth.refresh(); window.history.replaceState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }} />;
  }
  if (auth.status === 'loading') return <main className="auth-shell auth-state" aria-live="polite"><p>正在恢复登录状态…</p></main>;
  if (auth.status === 'anon') return <LoginPage error={auth.error} onRetry={auth.refresh} />;
  return <ConnectedWorkspace key={auth.teacherId} />;
}

function isAcceptInvitationRoute() {
  return window.location.pathname.replace(/\/$/, '') === '/accept-invitation';
}
