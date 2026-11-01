import * as FileSystem from "expo-file-system";
import type { KHATA_SETTLE_MODES, OrderCreateInput, SessionBillInput, SessionItemInput } from "@canavo/shared";
import { MODULE_DISABLED_RE, SUSPENDED_RE } from "../auth/access";
import { API_URL } from "./config";
import { deliveryRequests, type DateRange, type HandoverInput, type HandoverUpdate, type RequestSpec } from "../delivery/portal";
import { codRequests } from "../pos/cod";
import { registerRequests, type RecordPatch, type RegisterEntry } from "../attendance/register";
import * as secure from "./secure";
import type {
  ActiveOffer,
  AttendanceCalendar,
  CustomerList,
  CustomerLookupResult,
  CustomerProfile,
  Delivery,
  DeliveryAgent,
  DeliveryIssueReason,
  DeliveryQuote,
  DeliveryZone,
  DeliveryStatus,
  Floor,
  InventoryItem,
  InventoryList,
  KhataRemindResponse,
  LowStockAlerts,
  NotificationList,
  OutletsOverview,
  OwnerSummary,
  PromotionPreview,
  PurchaseDetail,
  PurchaseRow,
  SalesReport,
  SessionBillResponse,
  SessionDetail,
  StockAudit,
  StockAuditSummaryRow,
  AttendanceRecord,
  AttendanceStatus,
  DailyReport,
  Kot,
  KotStatus,
  LeaveRequest,
  LeaveType,
  Me,
  Menu,
  OtpRequestResponse,
  Order,
  Outlet,
  PaymentMode,
  PaymentResult,
  PaymentStatusResponse,
  Receipt,
  SyncResult,
  Tokens,
  MfaChallenge,
  UpiQrResponse,
  WhatsAppShareResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 for network failures/timeouts */
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isNetwork() {
    return this.status === 0;
  }
  /** 403: the feature's module is switched off for this business */
  get isModuleDisabled() {
    return this.status === 403 && MODULE_DISABLED_RE.test(this.message);
  }
  /** 403: the whole business account is suspended */
  get isSuspended() {
    return this.status === 403 && SUSPENDED_RE.test(this.message);
  }
}

/** Shown wherever a screen hits a module that isn't enabled (see <FeatureOff/>). */
export const FEATURE_OFF_MESSAGE =
  "This feature is not enabled for your business. Ask your business owner or CANAVO administrator to turn it on.";

export const isFeatureOff = (e: unknown) =>
  (e instanceof ApiError && e.isModuleDisabled) || (typeof e === "string" && (e === FEATURE_OFF_MESSAGE || MODULE_DISABLED_RE.test(e)));

export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof ApiError && e.isModuleDisabled) return FEATURE_OFF_MESSAGE;
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RequestOptions {
  /** Idempotency-Key for mutations (generated per call when omitted; reused on the auth retry) */
  idempotencyKey?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Attach the bearer token (default true) */
  auth?: boolean;
  /** Override the active outlet for this call (offline sync of another outlet's bills) */
  outletId?: string;
  timeoutMs?: number;
}

const REFRESH_SKEW_MS = 30_000;

/**
 * Typed client for the CANAVO API.
 *
 * - Access token is refreshed proactively shortly before expiry and reactively
 *   on a 401. The server rotates refresh tokens and treats reuse of a rotated
 *   token as theft, so only ONE refresh may be in flight at a time: concurrent
 *   callers share the same promise.
 * - Outlet-scoped calls carry `X-Outlet-Id`.
 */
class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshing: Promise<void> | null = null;
  outletId: string | null = null;

  /** Called when the session can't be recovered (refresh rejected). */
  onSessionExpired: (() => void) | null = null;
  /** Called when the API reports the business account is suspended. */
  onSuspended: ((message: string) => void) | null = null;
  /** Called whenever a new access token is obtained (socket re-auth). */
  onAccessToken: ((token: string) => void) | null = null;

  get hasSession() {
    return Boolean(this.refreshToken);
  }

  getAccessTokenSync() {
    return this.accessToken;
  }

  async restore(): Promise<boolean> {
    const [s, outletId] = await Promise.all([secure.readSession(), secure.readOutletId()]);
    this.outletId = outletId;
    if (!s) return false;
    this.accessToken = s.accessToken;
    this.refreshToken = s.refreshToken;
    this.accessExpiresAt = s.accessExpiresAt;
    return true;
  }

  async setTokens(t: Tokens) {
    this.accessToken = t.accessToken;
    this.refreshToken = t.refreshToken;
    this.accessExpiresAt = Date.now() + t.expiresIn * 1000;
    await secure.writeSession({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accessExpiresAt: this.accessExpiresAt,
    });
    this.onAccessToken?.(t.accessToken);
  }

  async clear() {
    this.accessToken = null;
    this.refreshToken = null;
    this.accessExpiresAt = 0;
    await secure.clearSession();
  }

  async setOutlet(id: string) {
    this.outletId = id;
    await secure.writeOutletId(id);
  }

  /** Ensure a usable access token, refreshing if it is about to expire. */
  async freshAccessToken(): Promise<string> {
    if (!this.refreshToken) throw new ApiError("Not signed in", 401);
    if (!this.accessToken || Date.now() > this.accessExpiresAt - REFRESH_SKEW_MS) await this.refresh();
    return this.accessToken!;
  }

  private refresh(): Promise<void> {
    if (!this.refreshing) {
      const token = this.refreshToken;
      this.refreshing = (async () => {
        if (!token) throw new ApiError("Not signed in", 401);
        try {
          const t = await this.raw<Tokens>("POST", "/auth/refresh", { body: { refreshToken: token }, auth: false });
          await this.setTokens(t);
        } catch (e) {
          // 401 = refresh token revoked/expired/reused → session is over.
          // Network errors keep the session so the app works again once online.
          if (e instanceof ApiError && e.status === 401) {
            await this.clear();
            this.onSessionExpired?.();
          }
          throw e;
        }
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]) {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return `${API_URL}${path}${qs ? `?${qs}` : ""}`;
  }

  private headers(opts: RequestOptions, token: string | null): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) h["Content-Type"] = "application/json";
    if (token) h.Authorization = `Bearer ${token}`;
    const outlet = opts.outletId ?? this.outletId;
    if (outlet) h["X-Outlet-Id"] = outlet;
    if (opts.idempotencyKey) h["Idempotency-Key"] = opts.idempotencyKey;
    return h;
  }

  /** Upload a photo from the device (multipart field "file"); returns its URL. */
  async uploadImage(uri: string, name = "photo.jpg", type = "image/jpeg"): Promise<string> {
    const token = await this.freshAccessToken();
    const form = new FormData();
    // React Native's FormData takes { uri, name, type } for local files.
    form.append("file", { uri, name, type } as unknown as Blob);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(this.buildUrl("/uploads/image"), {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(this.outletId && { "X-Outlet-Id": this.outletId }) },
        body: form,
        signal: controller.signal,
      });
    } catch {
      throw new ApiError("Couldn't upload the photo. Check your connection.", 0);
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !data.url) throw new ApiError(data.error ?? `Upload failed (${res.status})`, res.status);
    return data.url;
  }

  /** One HTTP round-trip with no auth recovery. */
  private async raw<T>(method: Method, path: string, opts: RequestOptions, token: string | null = null): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await fetch(this.buildUrl(path, opts.query), {
        method,
        headers: this.headers(opts, token),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new ApiError(aborted ? "Server took too long to respond" : "Can't reach the server. Check your connection.", 0);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const body = (data && typeof data === "object" ? data : {}) as { error?: string; details?: unknown };
      throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.details);
    }
    return data as T;
  }

  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    try {
      return await this.authed<T>(method, path, opts);
    } catch (e) {
      if (e instanceof ApiError && e.isSuspended && opts.auth !== false) this.onSuspended?.(e.message);
      throw e;
    }
  }

  private async authed<T>(method: Method, path: string, opts: RequestOptions): Promise<T> {
    if (opts.auth === false) return this.raw<T>(method, path, opts);
    // One key per call, reused by the refresh-and-retry below, so a mutation never runs twice.
    if (method !== "GET" && !opts.idempotencyKey) opts = { ...opts, idempotencyKey: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}` };
    const token = await this.freshAccessToken();
    try {
      return await this.raw<T>(method, path, opts, token);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401 || !this.refreshToken) throw e;
      // Token rejected (e.g. server restarted with a new secret) — refresh once and retry.
      await this.refresh();
      return this.raw<T>(method, path, opts, this.accessToken);
    }
  }

  /** Execute a request spec (see src/delivery/portal.ts). */
  send<T>(r: RequestSpec<T>, opts?: Omit<RequestOptions, "body" | "query">) {
    return this.request<T>(r.method, r.path, { ...opts, query: r.query, ...(r.body !== undefined && { body: r.body }) });
  }

  get<T>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} });
  }
  patch<T>(path: string, body: unknown, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  put<T>(path: string, body: unknown, opts?: RequestOptions) {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  delete<T>(path: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, opts);
  }

  /** Download an authenticated file (e.g. receipt PDF) to local storage. */
  async download(path: string, fileName: string): Promise<string> {
    const dest = `${FileSystem.cacheDirectory}${fileName}`;
    const attempt = async (token: string) =>
      FileSystem.downloadAsync(this.buildUrl(path), dest, { headers: this.headers({}, token) });
    let res = await attempt(await this.freshAccessToken());
    if (res.status === 401) {
      await this.refresh();
      res = await attempt(this.accessToken!);
    }
    if (res.status < 200 || res.status >= 300) throw new ApiError(`Download failed (${res.status})`, res.status);
    return res.uri;
  }
}

export const api = new ApiClient();

// ---------- Endpoint helpers ----------
export interface ClockInput {
  latitude: number;
  longitude: number;
  accuracy?: number;
  pin?: string;
  outletId?: string;
  /** The phone reports the location as fake (Android mock location) */
  mocked?: boolean;
  /** Selfie uploaded just before clocking in (when the hotel requires it) */
  selfieUrl?: string;
}

export const endpoints = {
  // Auth
  requestOtp: (phone: string) => api.post<OtpRequestResponse>("/auth/otp/request", { phone }, { auth: false }),
  verifyOtp: (phone: string, code: string, deviceId: string) =>
    api.post<Tokens | MfaChallenge>("/auth/otp/verify", { phone, code, deviceId }, { auth: false }),
  passwordLogin: (email: string, password: string) =>
    api.post<Tokens | MfaChallenge>("/auth/login", { email, password }, { auth: false }),
  verifyTwoFactor: (mfaToken: string, input: { code?: string; recoveryCode?: string }, deviceId: string) =>
    api.post<Tokens>("/auth/2fa/verify", { mfaToken, deviceId, ...input }, { auth: false }),
  logout: (refreshToken: string) => api.post<void>("/auth/logout", { refreshToken }, { auth: false }),
  me: () => api.get<Me>("/auth/me"),

  // Outlets
  currentOutlet: () => api.get<Outlet>("/outlets/current"),

  // Attendance
  attendanceStatus: () => api.get<AttendanceStatus>("/attendance/me/status"),
  clockIn: (input: ClockInput) => api.post<AttendanceRecord>("/attendance/clock-in", input),
  clockOut: (input: ClockInput) => api.post<AttendanceRecord>("/attendance/clock-out", input),
  calendar: (month: string) => api.get<AttendanceCalendar>("/attendance/calendar", { query: { month } }),
  myLeaves: () => api.get<LeaveRequest[]>("/attendance/leaves"),
  applyLeave: (input: { fromDate: string; toDate: string; type: LeaveType; reason: string }) =>
    api.post<LeaveRequest>("/attendance/leaves", input),
  // Staff attendance register (attendance:manage) — request shapes in src/attendance/register.ts
  attendanceRegister: (date?: string) => api.send(registerRequests.register(date)),
  saveAttendanceRegister: (date: string, entries: RegisterEntry[]) => api.send(registerRequests.save(date, entries), { timeoutMs: 30_000 }),
  updateAttendanceRecord: (id: string, patch: RecordPatch) => api.send(registerRequests.update(id, patch)),
  deleteAttendanceRecord: (id: string) => api.send(registerRequests.remove(id)),

  // Menu & orders
  menu: () => api.get<Menu>("/menu"),
  createOrder: (input: OrderCreateInput) => api.post<Order>("/orders", input),
  getOrder: (id: string) => api.get<Order>(`/orders/${id}`),
  syncOrders: (orders: OrderCreateInput[], outletId: string) =>
    api.post<{ results: SyncResult[] }>("/orders/sync", { orders }, { outletId, timeoutMs: 60_000 }),
  pay: (
    orderId: string,
    payments: { mode: PaymentMode; amount: number; reference?: string }[],
    tendered?: number,
    outletId?: string,
  ) => api.post<PaymentResult>(`/orders/${orderId}/payments`, { payments, tendered }, { outletId }),
  /** Cash on Delivery for an OPEN delivery order (`cod: false` undoes it). */
  markCod: (orderId: string, cod = true) => api.send(codRequests.markCod(orderId, cod)),
  upiQr: (orderId: string, amount?: number) => api.post<UpiQrResponse>(`/orders/${orderId}/upi-qr`, amount ? { amount } : {}),
  paymentStatus: (orderId: string) => api.get<PaymentStatusResponse>(`/orders/${orderId}/payment-status`),
  confirmUpi: (orderId: string, paymentId: string) =>
    api.post<{ paid: boolean }>(`/orders/${orderId}/payments/${paymentId}/confirm`, {}),
  devSimulateUpi: (orderId: string, paymentId: string) =>
    api.post<{ paid: boolean }>(`/orders/${orderId}/payments/${paymentId}/dev-simulate`, {}),
  receipt: (orderId: string) => api.get<Receipt>(`/orders/${orderId}/receipt`),
  shareWhatsApp: (orderId: string, phone: string) =>
    api.post<WhatsAppShareResponse>(`/orders/${orderId}/share/whatsapp`, { phone }),

  // Kitchen
  kots: () => api.get<Kot[]>("/kot"),
  updateKot: (id: string, status: KotStatus) => api.patch<Kot>(`/kot/${id}`, { status }),

  // Reports
  dailyReport: (date?: string) => api.get<DailyReport>("/reports/daily", { query: { date } }),
  salesReport: (from: string, to: string) =>
    api.get<SalesReport>("/reports/sales", { query: { from, to, groupBy: "day" } }),
  ownerSummary: () => api.get<OwnerSummary>("/reports/owner-summary"),
  outletsOverview: (date?: string) => api.get<OutletsOverview>("/reports/outlets/overview", { query: { date } }),

  // Tables & running tabs
  floor: () => api.get<Floor>("/tables/floor"),
  openTable: (tableId: string, body: { guests: number; customerName?: string; customerPhone?: string }) =>
    api.post<SessionDetail>(`/tables/${tableId}/open`, body),
  session: (id: string) => api.get<SessionDetail>(`/tables/sessions/${id}`),
  updateSession: (id: string, body: { guests?: number; customerName?: string | null; customerPhone?: string | null }) =>
    api.patch<SessionDetail>(`/tables/sessions/${id}`, body),
  addSessionItems: (id: string, items: SessionItemInput[]) =>
    api.post<{ kots: Kot[]; session: SessionDetail }>(`/tables/sessions/${id}/items`, { items }),
  /** Reason goes in the query string: some proxies drop DELETE bodies. */
  voidSessionItem: (id: string, itemId: string, reason: string) =>
    api.delete<SessionDetail>(`/tables/sessions/${id}/items/${itemId}`, { query: { reason } }),
  transferSession: (id: string, toTableId: string) =>
    api.post<SessionDetail>(`/tables/sessions/${id}/transfer`, { toTableId }),
  mergeSession: (id: string, tableIds: string[]) => api.post<SessionDetail>(`/tables/sessions/${id}/merge`, { tableIds }),
  billSession: (id: string, body: Partial<SessionBillInput>) =>
    api.post<SessionBillResponse>(`/tables/sessions/${id}/bill`, body, { timeoutMs: 30_000 }),
  closeSession: (id: string) => api.post<SessionDetail>(`/tables/sessions/${id}/close`, {}),

  // Customers, offers, promotions
  customerLookup: (phone: string) => api.get<CustomerLookupResult>("/customers/lookup", { query: { phone } }),
  customers: (search: string, page = 1) =>
    api.get<CustomerList>("/customers", { query: { search: search || undefined, page, limit: 30 } }),
  customer: (id: string) => api.get<CustomerProfile>(`/customers/${id}`),
  settleKhata: (id: string, body: { amount: number; mode: (typeof KHATA_SETTLE_MODES)[number]; note?: string }) =>
    api.post<{ customer: CustomerProfile["customer"] }>(`/customers/${id}/khata/settle`, body),
  remindKhata: (id: string) => api.post<KhataRemindResponse>(`/customers/${id}/khata/remind`, {}),
  previewPromotions: (input: OrderCreateInput) => api.post<PromotionPreview>("/customers/preview-promotions", input),
  activeOffers: () => api.get<{ at: string; offers: ActiveOffer[] }>("/offers/active"),

  // Delivery
  deliveryQuote: (q: { lat?: number; lng?: number }) => api.get<DeliveryQuote>("/delivery/quote", { query: q }),
  deliveryAgents: () => api.get<DeliveryAgent[]>("/delivery/agents"),
  deliveryZones: () => api.get<DeliveryZone[]>("/delivery/zones"),
  deliveries: (q: { active?: "1"; status?: DeliveryStatus } = {}) => api.get<Delivery[]>("/delivery", { query: q }),
  // Delivery partner portal (only /delivery/* — partners have no order:view)
  myDeliveries: () => api.send(deliveryRequests.mine()),
  myDeliveryHistory: (r?: DateRange) => api.send(deliveryRequests.history(r)),
  myDeliverySummary: (r?: DateRange) => api.send(deliveryRequests.summary(r)),
  delivery: (id: string) => api.send(deliveryRequests.get(id)),
  myCash: () => api.send(deliveryRequests.myCash()),
  completeDelivery: (id: string, cashCollected?: number) => api.send(deliveryRequests.complete(id, cashCollected), { timeoutMs: 30_000 }),
  reportDeliveryIssue: (id: string, reason: DeliveryIssueReason, note?: string) => api.send(deliveryRequests.issue(id, reason, note)),
  // Delivery partners' cash & activity (delivery:manage)
  partnerCash: () => api.send(deliveryRequests.cash()),
  cashHandovers: (q: { agentId?: string; from?: string; to?: string } = {}) => api.send(deliveryRequests.handovers(q)),
  recordHandover: (input: HandoverInput) => api.send(deliveryRequests.recordHandover(input)),
  updateHandover: (id: string, input: HandoverUpdate) => api.send(deliveryRequests.updateHandover(id, input)),
  deleteHandover: (id: string) => api.send(deliveryRequests.deleteHandover(id)),
  settlePartnerCash: (agentId: string) => api.send(deliveryRequests.settleCash(agentId)),
  partnerActivity: (q: { from?: string; to?: string; agentId?: string } = {}) => api.send(deliveryRequests.activity(q)),
  partnerTimeline: (agentId: string, date?: string) => api.send(deliveryRequests.timeline(agentId, date)),
  /** `force`: managers assigning a partner who's at the limit / on a run (after the 409 confirm). */
  assignDelivery: (id: string, agentId: string | null, force?: boolean) => api.send(deliveryRequests.assign(id, agentId, force)),
  markPartnerBack: (agentId: string) => api.send(deliveryRequests.markBack(agentId)),
  // Partner dispatch availability + foreground GPS while clocked in
  myDeliveryStatus: () => api.send(deliveryRequests.myStatus()),
  reportMyLocation: (lat: number, lng: number, accuracy?: number) => api.send(deliveryRequests.myLocation(lat, lng, accuracy)),
  deliveryStatus: (id: string, status: DeliveryStatus, note?: string) => api.send(deliveryRequests.status(id, status, note)),
  deliveryLocation: (id: string, lat: number, lng: number) =>
    api.post<{ ok: boolean; remainingKm: number | null }>(`/delivery/${id}/location`, { lat, lng }),

  // Inventory
  inventoryItems: (q: { search?: string; lowStock?: "1" } = {}) => api.get<InventoryList>("/inventory/items", { query: q }),
  inventoryLookup: (code: string) => api.get<InventoryItem>("/inventory/items/lookup", { query: { code } }),
  adjustStock: (id: string, body: { quantity?: number; setTo?: number; reason: string }) =>
    api.post<unknown>(`/inventory/items/${id}/adjust`, body),
  wastage: (items: { inventoryItemId: string; quantity: number; reason: string }[]) =>
    api.post<{ value: number }>("/inventory/wastage", { items }),
  inventoryCategories: () => api.get<{ category: string; count: number }[]>("/inventory/items/categories"),
  inventoryAlerts: () => api.get<LowStockAlerts>("/inventory/alerts"),
  audits: () => api.get<StockAuditSummaryRow[]>("/inventory/audits"),
  audit: (id: string) => api.get<StockAudit>(`/inventory/audits/${id}`),
  startAudit: (body: { notes?: string; category?: string } = {}) => api.post<StockAudit>("/inventory/audits", body),
  saveAuditCounts: (id: string, counts: { inventoryItemId: string; countedQty: number | null }[]) =>
    api.put<StockAudit>(`/inventory/audits/${id}/counts`, { counts }, { timeoutMs: 30_000 }),
  completeAudit: (id: string) => api.post<StockAudit>(`/inventory/audits/${id}/complete`, {}, { timeoutMs: 30_000 }),
  purchases: (status?: "DRAFT" | "RECEIVED") => api.get<PurchaseRow[]>("/inventory/purchases", { query: { status, limit: 50 } }),
  purchase: (id: string) => api.get<PurchaseDetail>(`/inventory/purchases/${id}`),
  receivePurchase: (id: string) => api.post<PurchaseDetail>(`/inventory/purchases/${id}/receive`, {}),

  // Notifications
  notifications: (q: { unread?: boolean; before?: string | null; limit?: number } = {}) =>
    api.get<NotificationList>("/notifications", {
      query: { unread: q.unread ? "1" : undefined, before: q.before ?? undefined, limit: q.limit },
    }),
  readNotification: (id: string) => api.post<{ unread: number }>(`/notifications/${encodeURIComponent(id)}/read`, {}),
  readAllNotifications: () => api.post<void>("/notifications/read-all", {}),
  clearReadNotifications: () => api.delete<{ deleted: number }>("/notifications/read"),
  registerDevice: (token: string, platform: "ios" | "android") =>
    api.post<unknown>("/notifications/devices", { token, platform }),
  unregisterDevice: (token: string) => api.delete<void>(`/notifications/devices/${encodeURIComponent(token)}`, { timeoutMs: 5_000 }),
};
