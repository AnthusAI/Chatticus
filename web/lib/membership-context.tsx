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
import { fetchMe, type MeResponse } from "./me";
import {
  deriveMembershipBranch,
  pickActiveOrg,
  type ActiveOrg,
  type MembershipBranch,
} from "./membership-state";

type MembershipState = {
  authLoading: boolean;
  meLoading: boolean;
  session: VerifiedSession | null;
  me: MeResponse | null;
  branch: MembershipBranch;
  activeOrg: ActiveOrg | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
};

const MembershipContext = createContext<MembershipState | null>(null);

export function MembershipProvider({ children }: { children: ReactNode }) {
  const [authLoading, setAuthLoading] = useState(true);
  const [meLoading, setMeLoading] = useState(false);
  const [session, setSession] = useState<VerifiedSession | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async (nextSession: VerifiedSession | null) => {
    if (!nextSession) {
      setMe(null);
      setMeLoading(false);
      return;
    }
    setMeLoading(true);
    try {
      setMe(await fetchMe());
      setError(null);
    } catch (caught) {
      setMe(null);
      setError(caught instanceof Error ? caught.message : "membership refresh failed");
    } finally {
      setMeLoading(false);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const nextSession = await getVerifiedSession();
      setSession(nextSession);
      setError(null);
      await refreshMe(nextSession);
    } catch (caught) {
      setSession(null);
      setMe(null);
      setError(caught instanceof Error ? caught.message : "auth refresh failed");
      setMeLoading(false);
    }
  }, [refreshMe]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshSession();
      if (!cancelled) {
        setAuthLoading(false);
      }
    })();
    const unbind = bindAuthEvents({
      onSessionChanged: () => {
        void refreshSession();
      },
      onError: (caught) => {
        setError(caught.message);
        setSession(null);
        setMe(null);
        setMeLoading(false);
      },
    });
    return () => {
      cancelled = true;
      unbind();
    };
  }, [refreshSession]);

  const branch = deriveMembershipBranch(session, me);
  const activeOrg = me ? pickActiveOrg(me) : null;

  const value = useMemo<MembershipState>(
    () => ({
      authLoading,
      meLoading,
      session,
      me,
      branch,
      activeOrg,
      error,
      signIn: async () => {
        setError(null);
        await signInWithGoogle();
      },
      signOut: async () => {
        setError(null);
        await signOut();
        setSession(null);
        setMe(null);
      },
      refreshMe: async () => {
        await refreshMe(session);
      },
    }),
    [activeOrg, authLoading, branch, error, me, meLoading, refreshMe, session],
  );

  return (
    <MembershipContext.Provider value={value}>{children}</MembershipContext.Provider>
  );
}

export function useMembership(): MembershipState {
  const context = useContext(MembershipContext);
  if (!context) {
    throw new Error("useMembership must be used within MembershipProvider.");
  }
  return context;
}
