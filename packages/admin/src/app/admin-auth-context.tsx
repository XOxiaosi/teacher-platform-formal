import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { login as requestLogin, logout as requestLogout, me, type AdminLoginCredentials } from '../api/adminAuth';

/**
 * 管理员认证上下文（packages/admin 骨架）：
 * 挂载 GET /me 三态（loading/authed/anon）；登录成功后 refresh 身份；logout 本地清态。
 * adminToken 由后端 cookie 管理，前端不存明文。
 */

export type AdminAuthStatus = 'loading' | 'authed' | 'anon';

interface AdminAuthContextValue {
  status: AdminAuthStatus;
  email: string | null;
  error: string | null;
  login: (credentials: AdminLoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
}

const DEFAULT_CONTEXT: AdminAuthContextValue = {
  status: 'loading',
  email: null,
  error: null,
  login: async () => undefined,
  logout: async () => undefined,
};

const AdminAuthContext = createContext<AdminAuthContextValue>(DEFAULT_CONTEXT);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AdminAuthStatus>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const current = await me();
      if (!mountedRef.current) return;
      if (current === null) {
        setEmail(null);
        setStatus('anon');
        return;
      }
      setEmail(current.email);
      setStatus('authed');
    } catch (refreshError) {
      if (!mountedRef.current) return;
      setEmail(null);
      setStatus('anon');
      setError(`无法连接服务器：${messageOf(refreshError)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleLogin = useCallback(async (credentials: AdminLoginCredentials) => {
    await requestLogin(credentials);
    await refresh();
  }, [refresh]);

  const handleLogout = useCallback(async () => {
    try {
      await requestLogout();
    } catch {
      // best-effort：登出请求失败也本地清态
    }
    if (!mountedRef.current) return;
    setEmail(null);
    setStatus('anon');
    setError(null);
  }, []);

  return (
    <AdminAuthContext.Provider value={{
      status,
      email: status === 'authed' ? email : null,
      error,
      login: handleLogin,
      logout: handleLogout,
    }}>
      {children}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AdminAuthContextValue {
  return useContext(AdminAuthContext);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
