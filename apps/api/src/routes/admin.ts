import { Router, type NextFunction, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  aadhaarSchema,
  auditLogQuerySchema,
  can,
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
import { addDays, startOfLocalDay } from "../lib/time";
import { authenticate, requireBusiness, requireOutlet, requirePermission } from "../middleware/auth";
import { ipAllowed, normalizeIp, superAdminIpWhitelist } from "../middleware/ip-whitelist";
import { sendSchedule } from "../services/report-schedules";
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
const RANK: Record<string, number> = { SUPER_ADMIN: 0, BUSINESS_OWNER: 1, OUTLET_MANAGER: 2 };
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

adminRouter.get("/audit-logs", requirePermission("audit:view"), async (req, res) => {
  const q = parse(auditLogQuerySchema, req.query);
  const tz = "Asia/Kolkata";
  // The platform admin sees only platform actions (hotel activity is private to the hotel).
  const scope: Prisma.AuditLogWhereInput = isPlatformAdmin(req)
    ? { OR: [{ action: { startsWith: "platform." } }, { action: { startsWith: "backup." } }, { user: { role: "SUPER_ADMIN", businessId: null } }] }
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
    if (write && !can(user.role, "outlet:manage") && !isPlatformAdmin(req)) throw forbidden("Only the owner can change business-wide settings");
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
  const user = await prisma.user.findUnique({ where: { id: param(req, "id") }, select: { id: true, name: true, role: true, aadhaarEnc: true, outlets: true } });
  if (!user || user.role === "SUPER_ADMIN") throw notFound("Staff member");
  const me = req.user!;
  if (me.role !== "BUSINESS_OWNER") {
    const own = user.id === me.id;
    if (!own && (!(rank(user.role) > rank(me.role)) || !user.outlets.some((o) => me.outletIds.includes(o.outletId)))) throw notFound("Staff member");
  }
  return user;
}

adminRouter.patch("/staff/:id/aadhaar", requirePermission("staff:manage"), async (req, res) => {
  const { aadhaar } = parse(aadhaarSchema, req.body);
  if (!verhoeffValid(aadhaar)) throw badRequest("Invalid Aadhaar number (checksum failed)");
  const user = await staffInScope(req);
  await prisma.user.update({ where: { id: user.id }, data: { aadhaarEnc: encrypt(aadhaar) } });
  await audit(req, "staff.aadhaar_set", "User", user.id, { last4: aadhaar.slice(-4) });
  res.json({ userId: user.id, aadhaar: maskAadhaar(aadhaar) });
});

adminRouter.get("/staff/:id/aadhaar", requirePermission("staff:manage"), async (req, res) => {
  const user = await staffInScope(req);
  if (!user.aadhaarEnc) return res.json({ userId: user.id, aadhaar: null });
  const plain = decrypt(user.aadhaarEnc);
  const reveal = req.query.reveal === "1" || req.query.reveal === "true";
  await audit(req, reveal ? "staff.aadhaar_reveal" : "staff.aadhaar_view", "User", user.id);
  res.json({ userId: user.id, aadhaar: reveal ? plain : maskAadhaar(plain), revealed: reveal });
});
