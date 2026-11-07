import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import { can, ROLE_PERMISSIONS, type ModuleKey, type Permission } from "@canavo/shared";
import { api, ApiError, endpoints } from "../lib/api";
import { kvGet, kvSet } from "../lib/db";
import { getDeviceId, readSession } from "../lib/secure";
import { connectSocket, disconnectSocket } from "../lib/socket";
import { unregisterPush } from "../notifications/push";
import type { Me, MfaChallenge, OutletRef, Tokens } from "../lib/types";
import { hasModule as profileHasModule, type AccessProfile } from "./access";

type Status = "loading" | "signedOut" | "signedIn";

interface AuthState {
  status: Status;
  me: Me | null;
  outlet: OutletRef | null;
  /** True when the profile came from the offline cache */
  stale: boolean;
  /** Effective permission from /auth/me (role ∩ the business's modules) */
  allowed: (p: Permission) => boolean;
  /** Module enabled for the current business (platform context = all) */
  hasModule: (m: ModuleKey) => boolean;
  /** Permissions + modules for the pure gating helpers in ./access */
  access: AccessProfile;
  /** Why the user was signed out (e.g. business suspended), shown on the login screen */
  signOutReason: string | null;
  /** Resolves with a challenge when two-step login is on (then call verifyTwoFactor) */
  loginWithOtp: (phone: string, code: string) => Promise<MfaChallenge | null>;
  loginWithPassword: (email: string, password: string) => Promise<MfaChallenge | null>;
  /** Second sign-in step: a 6-digit authenticator code or a recovery code */
  verifyTwoFactor: (mfaToken: string, input: { code?: string; recoveryCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchOutlet: (id: string) => Promise<void>;
  reloadMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const ME_CACHE = "auth:me";

function pickOutlet(me: Me, preferred: string | null): OutletRef | null {
  return me.outlets.find((o) => o.id === preferred) ?? me.outlets[0] ?? null;
}

/** Profiles cached by app versions before multi-business lack `permissions`; fall back to the role. */
function permitted(me: Me | null, p: Permission): boolean {
  if (!me) return false;
  return Array.isArray(me.permissions) ? me.permissions.includes(p) : can(me.role, p);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [outlet, setOutlet] = useState<OutletRef | null>(null);
  const [stale, setStale] = useState(false);
  const [signOutReason, setSignOutReason] = useState<string | null>(null);
  const outletRef = useRef<string | null>(null);

  const signOutLocal = useCallback(async (reason: string | null = null) => {
    setSignOutReason(reason);
    disconnectSocket();
    await api.clear();
    setMe(null);
    setOutlet(null);
    setStatus("signedOut");
  }, []);

  const applyMe = useCallback(async (profile: Me, fromCache: boolean) => {
    const chosen = pickOutlet(profile, api.outletId);
    if (chosen && chosen.id !== api.outletId) await api.setOutlet(chosen.id);
    // The platform admin never works in a hotel: the API refuses any request of theirs with an outlet header.
    if (profile.platformAdmin) api.outletId = null;
    outletRef.current = chosen?.id ?? null;
    setMe(profile);
    // Keep the same object on a profile refresh so effects keyed on the outlet don't re-run.
    setOutlet((cur) => (cur && chosen && cur.id === chosen.id && cur.name === chosen.name ? cur : chosen));
    setStale(fromCache);
    setStatus("signedIn");
    const token = api.getAccessTokenSync();
    if (token && !fromCache) connectSocket(token, chosen?.id ?? null);
  }, []);

  /** GET /auth/me (the business comes from the user's account, not the outlet header). */
  const fetchMe = useCallback(async (): Promise<Me> => {
    const profile = await endpoints.me();
    // Cached with the session so permission gating keeps working offline.
    await kvSet(ME_CACHE, profile);
    return profile;
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const profile = await fetchMe();
      await applyMe(profile, false);
    } catch (e) {
      // Offline at launch: keep working from the cached profile so the POS still bills.
      if (e instanceof ApiError && e.isNetwork) {
        const cached = await kvGet<Me>(ME_CACHE);
        if (cached) return applyMe(cached.value, true);
      }
      if (e instanceof ApiError && e.status === 401) return signOutLocal();
      if (e instanceof ApiError && e.isSuspended) return signOutLocal(e.message);
      throw e;
    }
  }, [applyMe, fetchMe, signOutLocal]);

  useEffect(() => {
    api.onSessionExpired = () => {
      void signOutLocal();
    };
    api.onAccessToken = (token) => connectSocket(token, outletRef.current);
    // Business suspended mid-shift: end the session and say why.
    api.onSuspended = (message) => {
      if (api.hasSession) void signOutLocal(message);
    };
    (async () => {
      try {
        if (await api.restore()) await loadMe();
        else setStatus("signedOut");
      } catch {
        setStatus("signedOut");
      }
    })();
    return () => {
      api.onSessionExpired = null;
      api.onAccessToken = null;
      api.onSuspended = null;
    };
  }, [loadMe, signOutLocal]);

  // Started offline on the cached profile → refresh it (and connect the socket) once back online.
  useEffect(() => {
    if (!stale) return;
    return NetInfo.addEventListener((s) => {
      if (s.isConnected && s.isInternetReachable !== false) loadMe().catch(() => undefined);
    });
  }, [stale, loadMe]);

  const finishLogin = useCallback(
    async (tokens: Tokens | MfaChallenge): Promise<MfaChallenge | null> => {
      if ("mfaRequired" in tokens) return tokens;
      setSignOutReason(null);
      await api.setTokens(tokens);
      await loadMe();
      return null;
    },
    [loadMe],
  );

  const value = useMemo<AuthState>(
    () => ({
      status,
      me,
      outlet,
      stale,
      allowed: (p) => permitted(me, p),
      hasModule: (m) => (me ? profileHasModule(me, m) : false),
      access: me
        ? { permissions: Array.isArray(me.permissions) ? me.permissions : ROLE_PERMISSIONS[me.role], modules: me.modules ?? null }
        : { permissions: [], modules: [] },
      signOutReason,
      loginWithOtp: async (phone, code) => finishLogin(await endpoints.verifyOtp(phone, code, await getDeviceId())),
      loginWithPassword: async (email, password) => finishLogin(await endpoints.passwordLogin(email, password)),
      verifyTwoFactor: async (mfaToken, input) => {
        await finishLogin(await endpoints.verifyTwoFactor(mfaToken, input, await getDeviceId()));
      },
      logout: async () => {
        // Needs the access token, so it runs before the session is cleared.
        await unregisterPush();
        const s = await readSession();
        if (s) endpoints.logout(s.refreshToken).catch(() => undefined);
        await signOutLocal();
      },
      switchOutlet: async (id) => {
        const next = me?.outlets.find((o) => o.id === id);
        if (!next) return;
        await api.setOutlet(id);
        outletRef.current = id;
        setOutlet(next);
        const token = api.getAccessTokenSync();
        if (token) connectSocket(token, id);
        // Refresh the profile (permissions / modules may have changed).
        try {
          const profile = await endpoints.me();
          await kvSet(ME_CACHE, profile);
          setMe(profile);
          setStale(false);
        } catch (e) {
          if (e instanceof ApiError && e.isSuspended) await signOutLocal(e.message);
          // Offline: keep the cached profile; it refreshes when the connection is back.
        }
      },
      reloadMe: loadMe,
    }),
    [status, me, outlet, stale, signOutReason, finishLogin, signOutLocal, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** Narrowed accessor for screens that only render when signed in. */
export function useSignedIn() {
  const auth = useAuth();
  if (!auth.me) throw new Error("useSignedIn used while signed out");
  return { ...auth, me: auth.me };
}
