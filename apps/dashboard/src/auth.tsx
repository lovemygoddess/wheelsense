import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, fetchAuthStatus, loginWithPassword, logout as apiLogout, setUnauthorizedHandler, getStoredRefreshToken, setRefreshToken, clearRefreshToken, type AuthStatus } from './api';

interface AuthContextValue {
  ready: boolean;
  unlocked: boolean;
  /** True when the last status check failed at the NETWORK level (DNS /
   *  timeout / refused / TLS) — i.e. the server address is probably wrong
   *  or the server is down. ApiError means an HTTP response arrived, so
   *  the server IS reachable. The login screen uses this to auto-open its
   *  server-address editor. */
  unreachable: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-run the connectivity check (e.g. after the user edits the URL). */
  retry: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const check = useCallback(async () => {
    try {
      const s = await fetchAuthStatus();
      setStatus(s);
      setUnreachable(false);
    } catch (e) {
      setUnreachable(!(e instanceof ApiError));
      setStatus({ unlocked: false, has_password: false });
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  // M10: any gated endpoint answering 401 'unauthenticated' flips the app
  // back to the login screen (RootNav watches `unlocked`). Previously each
  // page just showed a bare "HTTP 401" string. With a refresh token the app
  // retries silently first (see api.ts); this only fires when that fails.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearRefreshToken();
      setStatus(s => (s?.unlocked ? { unlocked: false, has_password: s.has_password } : s));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (password: string) => {
    const auth = await loginWithPassword(password);
    if (auth.refresh_token) {
      await setRefreshToken(auth.refresh_token);
    }
    setStatus({ unlocked: auth.unlocked, has_password: auth.has_password });
  }, []);

  const logout = useCallback(async () => {
    try {
      const tok = await getStoredRefreshToken();
      await apiLogout(tok);
    } catch {}
    await clearRefreshToken();
    setStatus({ unlocked: false, has_password: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ready, unlocked: status?.unlocked ?? false, unreachable, login, logout, retry: check }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
