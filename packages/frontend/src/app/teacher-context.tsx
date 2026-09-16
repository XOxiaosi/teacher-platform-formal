import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { logout as requestLogout, me } from '../api/auth';
import { onSessionExpired } from '../api/client';
import { clearAssistantDrafts } from '../connected/assistant/drafts';

export type AuthStatus = 'loading' | 'authed' | 'anon';

export interface AuthContextValue {
  status: AuthStatus;
  teacherId: string | null;
  email: string | null;
  displayName: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const ANON_CONTEXT: AuthContextValue = {
  status: 'loading',
  teacherId: null,
  email: null,
  displayName: null,
  error: null,
  refresh: async () => undefined,
  logout: async () => undefined,
};

const AuthContext = createContext<AuthContextValue>(ANON_CONTEXT);

export function TeacherProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [identity, setIdentity] = useState<{ teacherId: string; email: string; displayName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const identityRef = useRef<{ teacherId: string; email: string; displayName: string } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const current = await me();
      if (!mountedRef.current) return;
      if (current === null) {
        identityRef.current = null;
        setIdentity(null);
        setStatus('anon');
        return;
      }
      const nextIdentity = { teacherId: current.id, email: current.email, displayName: current.displayName };
      identityRef.current = nextIdentity;
      setIdentity(nextIdentity);
      setStatus('authed');
    } catch (refreshError) {
      if (!mountedRef.current) return;
      identityRef.current = null;
      setIdentity(null);
      setStatus('anon');
      setError(`无法连接服务器，请检查网络后重试：${messageOf(refreshError)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 业务请求 401（会话过期）→ 全局回调踢回匿名态（不吞 ApiError）
  useEffect(() => {
    return onSessionExpired(() => {
      if (!mountedRef.current) return;
      if (identityRef.current === null) return;
      identityRef.current = null;
      setIdentity(null);
      setStatus('anon');
      setError('会话已过期，请重新登录');
    });
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await requestLogout();
      if (!mountedRef.current) return;
      if (identityRef.current) clearAssistantDrafts(identityRef.current.teacherId);
      identityRef.current = null;
      setIdentity(null);
      setStatus('anon');
      setError(null);
    } catch (logoutError) {
      if (!mountedRef.current) return;
      setError(`退出登录失败，请重试：${messageOf(logoutError)}`);
    }
  }, []);

  const value: AuthContextValue = {
    status,
    teacherId: status === 'authed' && identity ? identity.teacherId : null,
    email: status === 'authed' && identity ? identity.email : null,
    displayName: status === 'authed' && identity ? identity.displayName : null,
    error,
    refresh,
    logout: handleLogout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function useTeacherId(): string | null {
  return useContext(AuthContext).teacherId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
