"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  bindAuthEvents,
  getVerifiedSession,
  signInWithGoogle,
  signOut,
  type VerifiedSession,
} from "./auth";

type AuthState = {
  loading: boolean;
  session: VerifiedSession | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<VerifiedSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await getVerifiedSession());
      setError(null);
    } catch (caught) {
      setSession(null);
      setError(caught instanceof Error ? caught.message : "auth refresh failed");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshSession();
      if (!cancelled) {
        setLoading(false);
      }
    })();
    const unbind = bindAuthEvents({
      onSessionChanged: () => {
        void refreshSession();
      },
      onError: (caught) => {
        setError(caught.message);
        setSession(null);
      },
    });
    return () => {
      cancelled = true;
      unbind();
    };
  }, [refreshSession]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      error,
      signIn: async () => {
        setError(null);
        await signInWithGoogle();
      },
      signOut: async () => {
        setError(null);
        await signOut();
        setSession(null);
      },
    }),
    [error, loading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return context;
}
