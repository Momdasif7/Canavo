/**
 * Typed fetch wrapper for the CANAVO API.
 *
 * - Attaches the bearer token and the active outlet (X-Outlet-Id).
 * - On 401, refreshes the access token once and retries. Refresh tokens rotate
 *   (the old one dies), so concurrent 401s share a single in-flight refresh,
 *   and a Web Lock serialises refreshes across browser tabs.
 * - Normalises API errors ({ error, details }) into ApiError.
 * - Reports reachability so the UI can switch to offline mode.
 */
import type { MfaChallenge, Session } from "./types";

/**
 * API base. Either absolute (http://localhost:4000) or a same-origin path such
 * as "/api" when the app and API are served through one gateway (e.g. ngrok).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Absolute API base, resolving a same-origin path against the current page. */
export const apiBase = () =>
  API_URL.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${API_URL}` : API_URL;

const SESSION_KEY = "canavo.session";
const OUTLET_KEY = "canavo.outlet";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    /** True when the request never reached the server */
    public network = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isNetworkError = (e: unknown): e is ApiError => e instanceof ApiError && e.network;

/** Human-readable message from any thrown value, including zod `flatten()` details. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] } | undefined;
    const field = d?.fieldErrors && Object.entries(d.fieldErrors).find(([, v]) => v?.length);
    if (field) return `${e.message}: ${field[0]} — ${field[1]![0]}`;
    if (d?.formErrors?.length) return `${e.message}: ${d.formErrors[0]}`;
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}

// ---------- Session storage ----------
const isBrowser = typeof window !== "undefined";

function readStoredSession(): Session | null {
  if (!isBrowser) return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let session: Session | null = readStoredSession();
const sessionListeners = new Set<(s: Session | null) => void>();

export function getSession(): Session | null {
  return session;
}

export function setSession(next: Session | null) {
  session = next;
  if (isBrowser) {
    try {
      if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable (private mode) — keep the in-memory session */
    }
  }
  sessionListeners.forEach((fn) => fn(next));
}

export function subscribeSession(fn: (s: Session | null) => void): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

let outletId: string | null = isBrowser ? safeGet(OUTLET_KEY) : null;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const getOutletId = () => outletId;

/**
 * Business a platform admin is acting in (sent as X-Business-Id so
 * business-level routes like POST /outlets work without an outlet). Ignored by
 * the API for business users, who always act in their own business.
 */
let businessId: string | null = null;
export const getBusinessId = () => businessId;
export function setBusinessId(id: string | null) {
  businessId = id;
}

/**
 * Support view (Phase 2.4): the platform admin opens a hotel whose owner granted support
 * access. Kept per browser tab (sessionStorage), sent as X-Support-Business; requests that
 * pass businessId: null (the platform console) never carry it.
 */
const SUPPORT_KEY = "canavo.support";
let supportBusinessId: string | null = (() => {
  try {
    return isBrowser ? sessionStorage.getItem(SUPPORT_KEY) : null;
  } catch {
    return null;
  }
})();
export const getSupportBusinessId = () => supportBusinessId;
export function setSupportBusinessId(id: string | null) {
  supportBusinessId = id;
  try {
    if (id) sessionStorage.setItem(SUPPORT_KEY, id);
    else sessionStorage.removeItem(SUPPORT_KEY);
  } catch {
    /* ignore */
  }
}

export function setOutletId(id: string | null) {
  outletId = id;
  try {
    if (id) localStorage.setItem(OUTLET_KEY, id);
    else localStorage.removeItem(OUTLET_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- Reachability ----------
const reachListeners = new Set<(reachable: boolean) => void>();
let lastReachable = true;

function markReachable(reachable: boolean) {
  if (reachable === lastReachable) return;
  lastReachable = reachable;
  reachListeners.forEach((fn) => fn(reachable));
}

export function subscribeReachability(fn: (reachable: boolean) => void): () => void {
  reachListeners.add(fn);
  return () => reachListeners.delete(fn);
}

/** Lightweight probe used while offline to detect when the API is back. */
export async function pingApi(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    markReachable(res.ok);
    return res.ok;
  } catch {
    markReachable(false);
    return false;
  }
}

// ---------- Token refresh ----------
let refreshing: Promise<string | null> | null = null;

/**
 * Get a fresh access token after `staleToken` was rejected. Returns null when
 * the session is gone (user must log in again). Throws ApiError(network) when
 * the API is unreachable so callers don't log the user out while offline.
 */
export function refreshAccessToken(staleToken: string | undefined): Promise<string | null> {
  refreshing ??= runRefresh(staleToken).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function runRefresh(staleToken: string | undefined): Promise<string | null> {
  const work = async (): Promise<string | null> => {
    // Another tab may have rotated the token while we waited for the lock.
    const stored = readStoredSession() ?? session;
    if (!stored) return null;
    if (staleToken && stored.accessToken !== staleToken) {
      session = stored;
      return stored.accessToken;
    }
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      });
    } catch {
      markReachable(false);
      throw new ApiError(0, "Network unavailable", undefined, true);
    }
    markReachable(true);
    if (!res.ok) {
      setSession(null);
      return null;
    }
    const next = (await res.json()) as Session;
    setSession(next);
    return next.accessToken;
  };
  if (isBrowser && "locks" in navigator && navigator.locks) {
    return navigator.locks.request("canavo-token-refresh", work);
  }
  return work();
}

// ---------- Requests ----------
type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  /** Idempotency-Key for mutations (generated per call when omitted; reused on internal retries) */
  idempotencyKey?: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body */
  body?: unknown;
  /** Non-JSON body (e.g. CSV text) — pair with contentType */
  rawBody?: BodyInit;
  contentType?: string;
  query?: Record<string, QueryValue>;
  /** Override the active outlet; null omits the header */
  outletId?: string | null;
  /** Override the platform-admin business context; null omits the header */
  businessId?: string | null;
  signal?: AbortSignal;
  /** Send the bearer token (default true) */
  auth?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.startsWith("http") ? path : `${apiBase()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function send(path: string, opts: RequestOptions, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const outlet = opts.outletId === undefined ? outletId : opts.outletId;
  if (outlet) headers["x-outlet-id"] = outlet;
  const business = opts.businessId === undefined ? businessId : opts.businessId;
  if (business) headers["x-business-id"] = business;
  if (supportBusinessId && opts.businessId !== null) headers["x-support-business"] = supportBusinessId;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (opts.contentType) headers["content-type"] = opts.contentType;
  } else if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
    // Multipart upload: no content-type, so the browser adds the boundary.
    body = opts.body;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
      cache: "no-store",
    });
    markReachable(true);
    return res;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    markReachable(false);
    throw new ApiError(0, "Network unavailable — check your connection", undefined, true);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let details: unknown;
  try {
    const data = (await res.json()) as { error?: string; details?: unknown };
    if (data.error) message = data.error;
    details = data.details;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message, details);
}

/** One key per user action: a retry of the same call (e.g. after a token refresh) can't run twice on the server. */
const newIdempotencyKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

export async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  const method = (opts.method ?? "GET").toUpperCase();
  if (method !== "GET" && opts.auth !== false && !opts.idempotencyKey) opts = { ...opts, idempotencyKey: newIdempotencyKey() };
  const useAuth = opts.auth !== false;
  const token = useAuth ? session?.accessToken : undefined;
  let res = await send(path, opts, token);
  if (res.status === 401 && useAuth && token) {
    const fresh = await refreshAccessToken(token);
    if (!fresh) throw new ApiError(401, "Your session has expired. Please log in again.");
    res = await send(path, opts, fresh);
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function json<T>(path: string, opts: RequestOptions): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m?.[1] ?? fallback;
}

export const api = {
  get: <T>(path: string, opts: Omit<RequestOptions, "method" | "body"> = {}) => json<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => json<T>(path, { ...opts, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => json<T>(path, { ...opts, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => json<T>(path, { ...opts, method: "PUT", body }),
  del: <T = void>(path: string, opts: RequestOptions = {}) => json<T>(path, { ...opts, method: "DELETE" }),
  text: async (path: string, opts: RequestOptions = {}) => (await request(path, opts)).text(),
  blob: async (path: string, opts: RequestOptions = {}, fallbackName = "download") => {
    const res = await request(path, opts);
    return { blob: await res.blob(), filename: filenameFrom(res, fallbackName) };
  },
};

// ---------- Auth helpers ----------
/** Password sign-in. With two-step login on, returns the challenge instead (call verifyTwoFactor next). */
export async function login(email: string, password: string): Promise<Session | MfaChallenge> {
  const s = await json<Session | MfaChallenge>("/auth/login", { method: "POST", body: { email, password }, auth: false, outletId: null });
  if (!("mfaRequired" in s)) setSession(s);
  return s;
}

/** Second sign-in step: a 6-digit app code or a recovery code. */
export async function verifyTwoFactor(mfaToken: string, input: { code?: string; recoveryCode?: string }): Promise<Session> {
  const s = await json<Session>("/auth/2fa/verify", { method: "POST", body: { mfaToken, ...input }, auth: false, outletId: null });
  setSession(s);
  return s;
}

/** API answer when the business doesn't subscribe to the module behind a route. */
export const isModuleOffError = (e: unknown) => e instanceof ApiError && e.status === 403 && /not enabled for your business/i.test(e.message);
export const isModuleOffMessage = (m: string | null | undefined) => !!m && /not enabled for your business/i.test(m);
export const isSuspendedMessage = (m: string | null | undefined) => !!m && /suspended/i.test(m) && /business/i.test(m);

export async function logout(): Promise<void> {
  setSupportBusinessId(null);
  const current = session;
  setSession(null);
  if (current) {
    try {
      await send("/auth/logout", { method: "POST", body: { refreshToken: current.refreshToken }, outletId: null }, undefined);
    } catch {
      /* best effort */
    }
  }
}
