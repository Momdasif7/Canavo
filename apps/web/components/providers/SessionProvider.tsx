"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Permission } from "@canavo/shared";
import {
  api,
  errorMessage,
  getOutletId,
  getSession,
  getSupportBusinessId,
  isNetworkError,
  logout as apiLogout,
  setBusinessId,
  setOutletId,
  setSupportBusinessId,
  subscribeSession,
} from "@/lib/api";
import { cacheGet, cachePut, loadOutlet } from "@/lib/offline";
import type { Me, Outlet } from "@/lib/types";

type Status = "loading" | "authenticated" | "anonymous" | "error";

interface SessionValue {
  status: Status;
  error: string | null;
  me: Me | null;
  /** Active outlet; always null for a platform admin (the platform console can't open a hotel) */
  outletId: string | null;
  /** Full settings of the active outlet (tax config etc.) */
  outlet: Outlet | null;
  /** True while switching outlet / business (me is being re-fetched) */
  switching: boolean;
  /**
   * Switch the active outlet. Re-fetches /auth/me, because the outlet decides the business, its modules
   * and therefore the effective permissions. Resolves with the new user.
   */
  setOutlet: (id: string | null) => Promise<Me | null>;
  /** Re-fetch /auth/me (e.g. after creating an outlet or when modules change). */
  refreshMe: () => Promise<Me | null>;
  /** Platform admin: open a hotel's read-only support view (the owner's grant must be active) */
  enterSupport: (businessId: string) => Promise<Me | null>;
  /** Leave the support view, back to the platform console */
  exitSupport: () => Promise<Me | null>;
  reloadOutlet: () => Promise<void>;
  /** Effective permission check (role ∩ business modules), from /auth/me */
  can: (p: Permission) => boolean;
  logout: () => Promise<void>;
  retry: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);
const ME_CACHE = "me";

const fetchMe = (outletId: string | null) => api.get<Me>("/auth/me", { outletId, businessId: null });

/**
 * Which outlet to act in. Business users always have one (their saved choice or
 * the first). Platform admins never act in an outlet: hotel data is private to
 * each hotel, and the API refuses any request of theirs carrying X-Outlet-Id.
 */
function pickOutlet(user: Me, saved: string | null): string | null {
  if (user.platformAdmin) return null;
  return user.outlets.find((o) => o.id === saved)?.id ?? user.outlets[0]?.id ?? null;
}

/** Point the API client at the session's outlet (never a business override: X-Business-Id is unused now). */
function applyContext(_user: Me, outletId: string | null) {
  setOutletId(outletId);
  setBusinessId(null);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletState] = useState<string | null>(null);
  const [outlet, setOutletData] = useState<Outlet | null>(null);
  const [switching, setSwitching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  // Load the user whenever a session appears; drop everything when it disappears.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!getSession()) {
        setMe(null);
        setStatus("anonymous");
        return;
      }
      setStatus("loading");
      const saved = getOutletId();
      let user: Me | undefined;
      let active: string | null = null;
      try {
        user = await fetchMe(saved);
        active = pickOutlet(user, saved);
        // The header we sent decides the business in the response; re-ask if it was stale.
        if (active !== saved) user = await fetchMe(active);
        void cachePut(ME_CACHE, user);
      } catch (e) {
        if (!isNetworkError(e) && getSupportBusinessId()) {
          // The support grant ended (or was revoked): back to the platform console.
          setSupportBusinessId(null);
          setOutletId(null);
          if (!cancelled) setAttempt((a) => a + 1);
          return;
        }
        if (isNetworkError(e)) {
          user = await cacheGet<Me>(ME_CACHE);
          if (user) active = pickOutlet(user, saved);
        }
        if (!user) {
          if (cancelled) return;
          if (!getSession()) setStatus("anonymous");
          else {
            setError(errorMessage(e));
            setStatus("error");
          }
          return;
        }
      }
      if (cancelled) return;
      applyContext(user, active);
      setOutletState(active);
      setMe(user);
      setStatus("authenticated");
    };
    void load();
    const unsub = subscribeSession((s) => {
      if (!s) {
        setMe(null);
        setOutletData(null);
        setBusinessId(null);
        setStatus("anonymous");
      } else if (!meRef.current) void load(); // token rotations don't reload the user
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [attempt]);

  const reloadOutlet = useCallback(async () => {
    if (!outletId) return;
    try {
      setOutletData((await loadOutlet(outletId)).data);
    } catch {
      /* settings unavailable offline without cache; POS falls back to defaults */
    }
  }, [outletId]);

  useEffect(() => {
    setOutletData(null);
    void reloadOutlet();
  }, [reloadOutlet]);

  const switchTo = useCallback(async (id: string | null, quiet = false): Promise<Me | null> => {
    // A real outlet switch hides the page while me reloads; a refresh keeps it mounted.
    if (!quiet) setSwitching(true);
    try {
      const user = await fetchMe(id);
      const active = pickOutlet(user, id);
      void cachePut(ME_CACHE, user);
      // Update the client headers and the user together so no page fetches with a mismatched business.
      applyContext(user, active);
      setOutletState(active);
      setMe(user);
      return user;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      // Offline: keep working in the chosen outlet with the cached user.
      const current = meRef.current;
      if (current && !current.platformAdmin && current.outlets.some((o) => o.id === id)) {
        setOutletId(id);
        setOutletState(id);
      }
      return current;
    } finally {
      setSwitching(false);
    }
  }, []);

  const refreshMe = useCallback(() => switchTo(getOutletId(), true), [switchTo]);

  const enterSupport = useCallback(
    async (businessId: string) => {
      setSupportBusinessId(businessId);
      setOutletId(null);
      try {
        return await switchTo(null);
      } catch (e) {
        setSupportBusinessId(null);
        await switchTo(null).catch(() => null);
        throw e;
      }
    },
    [switchTo],
  );

  const exitSupport = useCallback(async () => {
    setSupportBusinessId(null);
    setOutletId(null);
    return switchTo(null);
  }, [switchTo]);

  const logout = useCallback(async () => {
    await apiLogout();
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      error,
      me,
      outletId,
      outlet,
      switching,
      setOutlet: (id) => switchTo(id),
      refreshMe,
      enterSupport,
      exitSupport,
      reloadOutlet,
      can: (p) => Boolean(me?.permissions?.includes(p)),
      logout,
      retry: () => setAttempt((a) => a + 1),
    }),
    [status, error, me, outletId, outlet, switching, switchTo, refreshMe, enterSupport, exitSupport, reloadOutlet, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
