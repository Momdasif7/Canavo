import { Router, type NextFunction, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  aadhaarSetSchema,
  aadhaarSettingsSchema,
  AADHAAR_CONSENT_VERSION,
  type AadhaarMode,
  auditLogQuerySchema,
  brandSchema,
  normalizeBrand,
  reportScheduleSchema,
  restoreSchema,
  SETTING_KEYS,
  SETTING_SCHEMAS,
  type SettingKey,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, forbidden, notFound, param, parse } from "../lib/http";
import { decrypt, encrypt, maskAadhaar, verhoeffValid } from "../lib/crypto";
import { requireBusinessId } from "../lib/tenant";
import { addDays, isValidYmd as isRealDate, startOfLocalDay } from "../lib/time";
import { authenticate, requireBusiness, requireOutlet, requirePermission, userCan } from "../middleware/auth";
import { ipAllowed, normalizeIp, superAdminIpWhitelist } from "../middleware/ip-whitelist";
import { sendSchedule } from "../services/report-schedules";
import { DEFAULT_TEMPLATES, encryptSecret, getStoredConfig, getWaConfig, sendWhatsApp, WA_PURPOSES, WA_SETTING_KEY, type StoredWaConfig, type WaPurpose } from "../services/whatsapp";
import { assertBackupExists, createBackup, listBackups, restoreBackup, streamExport, tableCounts } from "../services/backup";

export const adminRouter = Router();
adminRouter.use(authenticate, superAdminIpWhitelist);

const isPlatformAdmin = (req: Request) => req.user?.role === "SUPER_ADMIN" && !req.user.businessId;

/** Owners / managers (settings:outlet); the platform admin only for platform-wide (GLOBAL) settings. */
function requireSettingsAccess(req: Request, _res: Response, next: NextFunction) {
  if (isPlatformAdmin(req)) {
    if (req.params.scope && req.params.scope !== "GLOBAL") throw forbidden("The platform admin only manages platform-wide settings");
    return next();
  }
  return requirePermission("settings:outlet")(req, _res, next);
}

/** Lower = more authority (same ladder as staff management). */
const RANK: Record<string, number> = { SUPER_ADMIN: 0, PLATFORM_SUPPORT: 0, BUSINESS_OWNER: 1, OUTLET_MANAGER: 2, ACCOUNTANT: 2, AUDITOR: 2 };
const rank = (role: string) => RANK[role] ?? 3;

// =====================================================================
// Report schedules
// =====================================================================

adminRouter.get("/report-schedules", requireOutlet, requirePermission("report:view"), async (req, res) => {
  const all = req.user!.role === "SUPER_ADMIN" && req.query.all === "1";
  res.json(await prisma.reportSchedule.findMany({ where: all ? {} : { outletId: req.outletId }, orderBy: { createdAt: "desc" } }));
});

adminRouter.post("/report-schedules", requireOutlet, requirePermission("report:view", "settings:outlet"), async (req, res) => {
  const data = parse(reportScheduleSchema, req.body);
  const schedule = await prisma.reportSchedule.create({ data: { ...data, outletId: req.outletId! } });
  await audit(req, "report_schedule.create", "ReportSchedule", schedule.id, { email: data.email, frequency: data.frequency, reports: data.reports });
  res.status(201).json(schedule);
});

async function ownSchedule(req: Request) {
  const s = await prisma.reportSchedule.findUnique({ where: { id: param(req, "id") } });
  if (!s || (req.user!.role !== "SUPER_ADMIN" && !req.user!.outletIds.includes(s.outletId))) throw notFound("Report schedule");
  return s;
}

adminRouter.delete("/report-schedules/:id", requirePermission("report:view", "settings:outlet"), async (req, res) => {
  const s = await ownSchedule(req);
  await prisma.reportSchedule.delete({ where: { id: s.id } });
  await audit(req, "report_schedule.delete", "ReportSchedule", s.id);
  res.status(204).end();
});

adminRouter.post("/report-schedules/:id/send-now", requirePermission("report:view"), async (req, res) => {
  const s = await ownSchedule(req);
  const result = await sendSchedule(s);
  await audit(req, "report_schedule.send", "ReportSchedule", s.id, { delivered: result.delivered });
  res.json(result);
});

// =====================================================================
// Audit logs
// =====================================================================

/** "2026-13-45" passes the YYYY-MM-DD pattern but isn't a date (it crashed the IST day maths with a 500). */
const auditQuery = auditLogQuerySchema.refine((q) => [q.from, q.to].every((d) => d === undefined || isRealDate(d)), { message: "Not a real date", path: ["from"] });

adminRouter.get("/audit-logs", requirePermission("audit:view"), async (req, res) => {
  const q = parse(auditQuery, req.query);
  const tz = "Asia/Kolkata";
  // The platform admin sees only platform actions (hotel activity is private to the hotel).
  // Owners see their whole business, including business-level actions with no outlet (settings,
  // staff, exports; BUG-003) — the tenant filter keeps it to their business. Managers see their outlets.
  const ownerScope: Prisma.AuditLogWhereInput = q.outletId && req.user!.outletIds.includes(q.outletId) ? { outletId: q.outletId } : {};
  const scope: Prisma.AuditLogWhereInput = isPlatformAdmin(req)
    ? { OR: [{ action: { startsWith: "platform." } }, { action: { startsWith: "backup." } }, { user: { role: "SUPER_ADMIN", businessId: null } }] }
    : req.user!.role === "BUSINESS_OWNER"
      ? ownerScope
      : { outletId: q.outletId && req.user!.outletIds.includes(q.outletId) ? q.outletId : { in: req.user!.outletIds } };
  const where: Prisma.AuditLogWhereInput = {
    ...scope,
    ...(q.entity && { entity: q.entity }),
    ...(q.action && { action: q.action.endsWith("*") ? { startsWith: q.action.slice(0, -1) } : q.action }),
    ...(q.userId && { userId: q.userId }),
    ...((q.from || q.to) && {
      createdAt: {
        ...(q.from && { gte: startOfLocalDay(q.from, tz) }),
        ...(q.to && { lt: startOfLocalDay(addDays(q.to, 1), tz) }),
      },
    }),
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);
  res.json({ items, total, page: q.page, pageSize: q.pageSize, pages: Math.ceil(total / q.pageSize) });
});

// =====================================================================
// Settings
// =====================================================================

const SETTING_DEFAULTS: Record<SettingKey, unknown> = {
  "notifications.prefs": { "*": { push: true, sms: false, email: false, whatsapp: false } },
  "printer.defaults": SETTING_SCHEMAS["printer.defaults"].parse({}),
  "whatsapp.templates": {},
  "service.preOrderLeadMinutes": 30,
  "security.ipWhitelist": [],
};
const GLOBAL_ONLY: SettingKey[] = ["security.ipWhitelist"];

async function settingTarget(req: Request, write: boolean) {
  let scope = param(req, "scope");
  // For a business user "GLOBAL" means their business; only platform admins edit true platform defaults.
  const platformAdmin = req.user!.role === "SUPER_ADMIN" && !req.user!.businessId && !req.businessId;
  if (scope === "GLOBAL" && !platformAdmin && req.businessId && !GLOBAL_ONLY.includes(param(req, "key") as SettingKey)) {
    scope = req.businessId;
  }
  const key = param(req, "key") as SettingKey;
  if (!SETTING_KEYS.includes(key)) throw badRequest(`Unknown setting key. Allowed: ${SETTING_KEYS.join(", ")}`);
  const user = req.user!;
  if (key === "security.ipWhitelist" && user.role !== "SUPER_ADMIN") throw forbidden("Super admin only");
  if (scope === "GLOBAL" || scope === req.businessId) {
    if (write && !userCan(req, "outlet:manage") && !isPlatformAdmin(req)) throw forbidden("Only the owner can change business-wide settings");
  } else {
    if (GLOBAL_ONLY.includes(key)) throw badRequest(`${key} can only be set at GLOBAL scope`);
    if (user.role !== "SUPER_ADMIN" && !user.outletIds.includes(scope)) throw forbidden("You are not assigned to this outlet");
    if (!(await prisma.outlet.findUnique({ where: { id: scope }, select: { id: true } }))) throw notFound("Outlet");
  }
  return { scope, key };
}

adminRouter.get("/settings", requireSettingsAccess, (_req, res) => {
  res.json({ keys: SETTING_KEYS, defaults: SETTING_DEFAULTS, globalOnly: GLOBAL_ONLY });
});

adminRouter.get("/settings/:scope/:key", requireSettingsAccess, async (req, res) => {
  const { scope, key } = await settingTarget(req, false);
  const s = await prisma.setting.findUnique({ where: { scope_key: { scope, key } } });
  res.json({ scope, key, value: s?.value ?? SETTING_DEFAULTS[key], isDefault: !s, updatedAt: s?.updatedAt ?? null });
});

adminRouter.put("/settings/:scope/:key", requireSettingsAccess, async (req, res) => {
  const { scope, key } = await settingTarget(req, true);
  const body = req.body && typeof req.body === "object" && "value" in req.body ? (req.body as { value: unknown }).value : req.body;
  const value = parse(SETTING_SCHEMAS[key] as z.ZodTypeAny, body) as Prisma.InputJsonValue;
  if (key === "security.ipWhitelist" && Array.isArray(value) && value.length && !ipAllowed(req.ip ?? "", value as string[])) {
    throw badRequest(`Refusing to save: your current IP ${normalizeIp(req.ip ?? "")} is not in the list (you would lock yourself out)`);
  }
  const s = await prisma.setting.upsert({
    where: { scope_key: { scope, key } },
    create: { scope, key, value },
    update: { value },
  });
  await audit(req, "setting.update", "Setting", `${scope}:${key}`, { value });
  res.json({ scope, key, value: s.value, updatedAt: s.updatedAt });
});

// =====================================================================
// Business brand (Appearance): accent colour + corner style for everyone
// in the business. Each user's own look is /auth/me/preferences.
// =====================================================================

adminRouter.get("/brand", requireBusiness, async (_req, res) => {
  const b = await prisma.business.findUniqueOrThrow({ where: { id: requireBusinessId() }, select: { brand: true } });
  res.json(normalizeBrand(b.brand));
});

/** Owner (outlet:manage) sets the business brand; omitted fields reset to the CANAVO default. */
adminRouter.put("/brand", requirePermission("outlet:manage"), requireBusiness, async (req, res) => {
  const brand = parse(brandSchema, req.body);
  await prisma.business.update({ where: { id: requireBusinessId() }, data: { brand } });
  await audit(req, "business.brand", "Business", requireBusinessId(), brand);
  res.json(brand);
});

// =====================================================================
// Backup & restore (platform admin) — technical, whole-platform disaster
// recovery. Backups can be created and restored but not downloaded: the
// platform admin never reads hotel data. Each owner exports their own data.
// =====================================================================

adminRouter.post("/backups", requirePermission("admin:backup"), async (req, res) => {
  const result = await createBackup("manual");
  await audit(req, "backup.create", "Backup", result.file, { rows: result.rows, size: result.size });
  res.status(201).json(result);
});

adminRouter.get("/backups", requirePermission("admin:backup"), async (_req, res) => {
  res.json(await listBackups());
});

adminRouter.post("/backups/:file/restore", requirePermission("admin:backup"), async (req, res) => {
  parse(restoreSchema, req.body);
  const file = param(req, "file");
  await assertBackupExists(file);
  const userId = req.user!.id;
  const result = await restoreBackup(file);
  // Audit after the restore (the audit table itself was restored). The acting user may not exist in the backup.
  const actorExists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  await prisma.auditLog.create({
    data: { userId: actorExists ? userId : null, action: "backup.restore", entity: "Backup", entityId: file, meta: { rows: result.rows }, ip: req.ip },
  });
  res.json(result);
});

adminRouter.get("/table-counts", requirePermission("admin:backup"), async (_req, res) => {
  res.json(await tableCounts());
});

/** Owner: download all of their own business's data (other hotels' data is never included). */
adminRouter.get("/export", requirePermission("data:export"), requireBusiness, async (req, res) => {
  const { format } = parse(z.object({ format: z.enum(["json", "csv-zip"]).default("json") }), req.query);
  await audit(req, "data.export", "Export", undefined, { format });
  await streamExport(res, format, req.businessId!);
});

// =====================================================================
// Aadhaar (encrypted PII)
// =====================================================================

/**
 * Aadhaar is visible to the hotel's owner (everyone in the business) and its
 * managers (staff of their own outlets, below them — not other managers or
 * the owner). The tenant filter keeps it inside one business.
 */
async function staffInScope(req: Request) {
  const user = await prisma.user.findUnique({
    where: { id: param(req, "id") },
    select: { id: true, name: true, role: true, aadhaarEnc: true, aadhaarLast4: true, aadhaarConsentAt: true, aadhaarConsentById: true, aadhaarConsentVersion: true, outlets: true },
  });
  if (!user || user.role === "SUPER_ADMIN") throw notFound("Staff member");
  const me = req.user!;
  if (me.role !== "BUSINESS_OWNER") {
    const own = user.id === me.id;
    if (!own && (!(rank(user.role) > rank(me.role)) || !user.outlets.some((o) => me.outletIds.includes(o.outletId)))) throw notFound("Staff member");
  }
  return user;
}

/** Aadhaar is never shown in a support view, even read-only (Phase 2.4). */
function noSupport(req: Request) {
  if (req.support) throw forbidden("Staff Aadhaar isn't available in a support view");
}

async function aadhaarMode(): Promise<AadhaarMode> {
  const b = await prisma.business.findUniqueOrThrow({ where: { id: requireBusinessId() }, select: { aadhaarMode: true } });
  return b.aadhaarMode;
}

/** Last 4 digits on file (computed from the encrypted number for records saved before Phase 2.5). */
const last4Of = (u: { aadhaarLast4: string | null; aadhaarEnc: string | null }) => u.aadhaarLast4 ?? (u.aadhaarEnc ? decrypt(u.aadhaarEnc).slice(-4) : null);

/**
 * Save a staff member's Aadhaar with their consent (Phase 2.5). Default (LAST4): only the last
 * 4 digits are kept — the full number is checked (Verhoeff) and dropped. FULL (hotel opt-in):
 * the full number is stored encrypted as well.
 */
adminRouter.patch("/staff/:id/aadhaar", requirePermission("staff:manage"), async (req, res) => {
  noSupport(req);
  const { aadhaar } = parse(aadhaarSetSchema, req.body);
  if (!verhoeffValid(aadhaar)) throw badRequest("Invalid Aadhaar number (checksum failed)");
  const user = await staffInScope(req);
  const mode = await aadhaarMode();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      aadhaarLast4: aadhaar.slice(-4),
      aadhaarEnc: mode === "FULL" ? encrypt(aadhaar) : null,
      aadhaarConsentAt: new Date(),
      aadhaarConsentById: req.user!.id,
      aadhaarConsentVersion: `${AADHAAR_CONSENT_VERSION}:${mode}`,
    },
  });
  await audit(req, "staff.aadhaar_set", "User", user.id, { last4: aadhaar.slice(-4), mode, consentVersion: AADHAAR_CONSENT_VERSION });
  res.json({ userId: user.id, aadhaar: maskAadhaar(aadhaar), fullStored: mode === "FULL", mode });
});

adminRouter.get("/staff/:id/aadhaar", requirePermission("staff:manage"), async (req, res) => {
  noSupport(req);
  const user = await staffInScope(req);
  const mode = await aadhaarMode();
  const last4 = last4Of(user);
  const consent = user.aadhaarConsentAt ? { at: user.aadhaarConsentAt, byId: user.aadhaarConsentById, version: user.aadhaarConsentVersion } : null;
  if (!last4) return res.json({ userId: user.id, aadhaar: null, fullStored: false, mode, consent });
  const reveal = (req.query.reveal === "1" || req.query.reveal === "true") && Boolean(user.aadhaarEnc);
  await audit(req, reveal ? "staff.aadhaar_reveal" : "staff.aadhaar_view", "User", user.id);
  res.json({
    userId: user.id,
    aadhaar: reveal ? decrypt(user.aadhaarEnc!) : `XXXX-XXXX-${last4}`,
    revealed: reveal,
    fullStored: Boolean(user.aadhaarEnc),
    mode,
    consent,
  });
});

/** Delete a staff member's Aadhaar record (e.g. they asked for it, or left). */
adminRouter.delete("/staff/:id/aadhaar", requirePermission("staff:manage"), async (req, res) => {
  noSupport(req);
  const user = await staffInScope(req);
  await prisma.user.update({
    where: { id: user.id },
    data: { aadhaarEnc: null, aadhaarLast4: null, aadhaarConsentAt: null, aadhaarConsentById: null, aadhaarConsentVersion: null },
  });
  await audit(req, "staff.aadhaar_deleted", "User", user.id);
  res.status(204).end();
});

/** How this hotel stores staff Aadhaar, and how many full numbers are on file. */
adminRouter.get("/aadhaar-settings", requirePermission("staff:manage"), requireBusiness, async (req, res) => {
  noSupport(req);
  const mode = await aadhaarMode();
  const fullNumbersStored = await prisma.user.count({ where: { aadhaarEnc: { not: null } } });
  res.json({ mode, fullNumbersStored });
});

/** Owner: choose LAST4 (default) or FULL. Switching to LAST4 doesn't touch numbers already stored. */
adminRouter.patch("/aadhaar-settings", requirePermission("outlet:manage"), requireBusiness, async (req, res) => {
  noSupport(req);
  const { mode } = parse(aadhaarSettingsSchema, req.body);
  await prisma.business.update({ where: { id: requireBusinessId() }, data: { aadhaarMode: mode } });
  await audit(req, "business.aadhaar_mode", "Business", requireBusinessId(), { mode });
  res.json({ mode });
});

/** Owner: keep only the last 4 digits of every stored number (irreversible). */
adminRouter.post("/aadhaar/reduce-to-last4", requirePermission("outlet:manage"), requireBusiness, async (req, res) => {
  noSupport(req);
  parse(z.object({ confirm: z.literal("REDUCE") }), req.body);
  const users = await prisma.user.findMany({ where: { aadhaarEnc: { not: null } }, select: { id: true, aadhaarEnc: true, aadhaarLast4: true } });
  await prisma.$transaction(async (tx) => {
    for (const u of users) await tx.user.update({ where: { id: u.id }, data: { aadhaarLast4: last4Of(u), aadhaarEnc: null } });
  });
  await audit(req, "business.aadhaar_reduced", "Business", requireBusinessId(), { count: users.length });
  res.json({ reduced: users.length });
});

// =====================================================================
// WhatsApp (per business): provider, keys (encrypted), templates, test send
// =====================================================================

const waTemplatesSchema = z.object(Object.fromEntries(WA_PURPOSES.map((p) => [p, z.string().trim().max(512).optional()])) as Record<WaPurpose, z.ZodOptional<z.ZodString>>);
const waConfigSchema = z.object({
  provider: z.enum(["NONE", "META", "WATI"]),
  meta: z
    .object({
      phoneNumberId: z.string().trim().regex(/^\d{6,20}$/, "Phone number ID is the numeric id from Meta's WhatsApp → API setup page"),
      /** Omit to keep the saved token */
      accessToken: z.string().trim().min(20).max(1024).optional(),
      language: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, "Template language code, e.g. en or en_US").default("en"),
    })
    .optional(),
  wati: z
    .object({
      apiUrl: z.string().trim().url().refine((u) => u.startsWith("https://"), "WATI API URL must start with https://"),
      token: z.string().trim().min(10).max(2048).optional(),
    })
    .optional(),
  templates: waTemplatesSchema.optional(),
  autoDeliveryUpdates: z.boolean().default(false),
  staffAlerts: z.boolean().default(false),
});

const last4 = (s: string) => (s ? `••••${s.slice(-4)}` : null);

/** Masked view of the business's WhatsApp setup (tokens are never returned). */
adminRouter.get("/whatsapp", requirePermission("settings:outlet"), requireBusiness, async (req, res) => {
  const stored = await getStoredConfig(req.businessId!);
  const cfg = await getWaConfig(req.businessId!);
  res.json({
    provider: stored?.provider ?? (cfg.fromEnv ? "WATI" : "NONE"),
    fromEnv: cfg.fromEnv,
    meta: stored?.meta ? { phoneNumberId: stored.meta.phoneNumberId, language: stored.meta.language ?? "en", token: last4(cfg.meta?.accessToken ?? "") } : null,
    wati: stored?.wati ? { apiUrl: stored.wati.apiUrl, token: last4(cfg.wati?.token ?? "") } : null,
    templates: cfg.templates,
    defaultTemplates: DEFAULT_TEMPLATES,
    autoDeliveryUpdates: cfg.autoDeliveryUpdates,
    staffAlerts: cfg.staffAlerts,
  });
});

adminRouter.put("/whatsapp", requirePermission("settings:outlet"), requireBusiness, async (req, res) => {
  const data = parse(waConfigSchema, req.body);
  const prev = await getStoredConfig(req.businessId!);
  if (data.provider === "META") {
    if (!data.meta) throw badRequest("Enter the Meta phone number ID and access token");
    if (!data.meta.accessToken && !prev?.meta?.accessTokenEnc) throw badRequest("Enter the Meta access token");
  }
  if (data.provider === "WATI") {
    if (!data.wati) throw badRequest("Enter the WATI API URL and token");
    if (!data.wati.token && !prev?.wati?.tokenEnc) throw badRequest("Enter the WATI API token");
  }
  const templates = Object.fromEntries(Object.entries(data.templates ?? {}).filter(([, v]) => v)) as Partial<Record<WaPurpose, string>>;
  const value: StoredWaConfig = {
    provider: data.provider,
    meta: data.meta
      ? { phoneNumberId: data.meta.phoneNumberId, language: data.meta.language, accessTokenEnc: data.meta.accessToken ? encryptSecret(data.meta.accessToken) : prev?.meta?.accessTokenEnc }
      : prev?.meta,
    wati: data.wati ? { apiUrl: data.wati.apiUrl, tokenEnc: data.wati.token ? encryptSecret(data.wati.token) : prev?.wati?.tokenEnc } : prev?.wati,
    templates,
    autoDeliveryUpdates: data.autoDeliveryUpdates,
    staffAlerts: data.staffAlerts,
  };
  await prisma.setting.upsert({
    where: { scope_key: { scope: req.businessId!, key: WA_SETTING_KEY } },
    create: { scope: req.businessId!, key: WA_SETTING_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
  // Audit without secrets
  await audit(req, "whatsapp.config", "Setting", WA_SETTING_KEY, {
    provider: data.provider,
    tokenChanged: Boolean(data.meta?.accessToken || data.wati?.token),
    autoDeliveryUpdates: data.autoDeliveryUpdates,
    staffAlerts: data.staffAlerts,
  });
  res.json({ ok: true });
});

/** Send a test message through the saved provider (uses the "test" template, default hello_world). */
adminRouter.post("/whatsapp/test", requirePermission("settings:outlet"), requireBusiness, async (req, res) => {
  const { phone } = parse(z.object({ phone: z.string().trim().regex(/^(\+?91)?[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number") }), req.body);
  const result = await sendWhatsApp({
    to: phone.slice(-10),
    text: "Test message from CANAVO: WhatsApp is connected.",
    purpose: "test",
    tag: "canavo_test",
    params: [{ name: "message", value: "WhatsApp is connected" }],
  });
  await audit(req, "whatsapp.test", "Setting", WA_SETTING_KEY, { provider: result.provider, method: result.method, error: result.error });
  res.json(result);
});
