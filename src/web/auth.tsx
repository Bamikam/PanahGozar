import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "operator" | "viewer";
}

interface MeResponse {
  user: AuthUser;
  csrfToken: string;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  canOperate: boolean;
  isAdmin: boolean;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
  canOperate: false,
  isAdmin: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>("/api/auth/me");
      setUser(me.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await api.get<MeResponse>("/api/auth/me");
        if (alive) setUser(me.user);
      } catch {
        if (alive) setUser(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("pg:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pg:unauthorized", onUnauthorized);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.post<{ user: MeResponse["user"] }>("/api/auth/login", {
      username,
      password,
    });
    setUser({
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      loading,
      login,
      logout,
      refresh,
      canOperate: user?.role === "admin" || user?.role === "operator",
      isAdmin: user?.role === "admin",
    }),
    [user, loading, login, logout, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  return useContext(Ctx);
}
