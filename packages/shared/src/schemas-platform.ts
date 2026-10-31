// Zod schemas & types for the platform module (owned by that module's implementer).
import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Keys accepted by the report endpoints and report schedules. */
export const REPORT_KEYS = [
  "sales",
  "items",
  "categories",
  "peak-hours",
  "gst",
  "profit",
  "staff",
  "customers",
  "inventory",
  "delivery",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const reportRangeSchema = z
  .object({
    from: ymd.optional(),
    to: ymd.optional(),
    format: z.enum(["json", "xlsx", "pdf"]).default("json"),
  })
  .passthrough();

export const reportScheduleSchema = z.object({
  email: z.string().email(),
  frequency: z.enum(["DAILY", "WEEKLY"]),
  reports: z.array(z.enum(REPORT_KEYS)).min(1).max(REPORT_KEYS.length),
  active: z.boolean().default(true),
});
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;

// ---------- Settings (key → value schema) ----------

const channelPrefs = z
  .object({
    push: z.boolean().default(true),
    sms: z.boolean().default(false),
    email: z.boolean().default(false),
    whatsapp: z.boolean().default(false),
  })
  .strict();

/** Event kind (e.g. "attendance.late", "inventory.low", or a prefix like "attendance", or "*") → channels. */
const notificationPrefs = z.record(z.string().regex(/^(\*|[a-z_]+(\.[a-z_]+)*)$/, "Invalid event key").max(64), channelPrefs);

const printerDefaults = z
  .object({
    paperWidth: z.union([z.literal(58), z.literal(80)]).default(58),
    autoPrintReceipt: z.boolean().default(false),
    autoPrintKot: z.boolean().default(true),
    receiptCopies: z.number().int().min(1).max(5).default(1),
    kotCopies: z.number().int().min(1).max(5).default(1),
    printerName: z.string().max(100).optional(),
    /** Kitchen station → printer name */
    kotPrinters: z.record(z.string().max(40), z.string().max(100)).default({}),
  })
  .strict();

const whatsappTemplates = z.record(
  z.string().regex(/^[a-z_]+$/, "Template key must be snake_case").max(40),
  z.object({ template: z.string().min(1).max(100), language: z.string().min(2).max(10).default("en") }).strict(),
);

const ipOrCidr = z
  .string()
  .trim()
  .refine((s) => {
    const [ip, bits, extra] = s.split("/");
    if (extra !== undefined) return false;
    const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip);
    const v6 = !v4 && /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");
    if (!v4 && !v6) return false;
    if (bits === undefined) return true;
    const n = Number(bits);
    return Number.isInteger(n) && n >= 0 && n <= (v4 ? 32 : 128);
  }, "Must be an IPv4/IPv6 address or CIDR");

export const SETTING_SCHEMAS = {
  "notifications.prefs": notificationPrefs,
  "printer.defaults": printerDefaults,
  "whatsapp.templates": whatsappTemplates,
  "service.preOrderLeadMinutes": z.number().int().min(0).max(24 * 60),
  "security.ipWhitelist": z.array(ipOrCidr).max(50),
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const deviceTokenSchema = z.object({
  token: z.string().min(10).max(300),
  platform: z.enum(["ios", "android", "web"]),
});

export const aadhaarSchema = z.object({
  aadhaar: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^[2-9]\d{11}$/, "Aadhaar must be 12 digits and cannot start with 0 or 1")),
});

export const restoreSchema = z.object({ confirm: z.literal("RESTORE") });

export const auditLogQuerySchema = z.object({
  entity: z.string().optional(),
  action: z.string().optional(),
  userId: z.string().optional(),
  outletId: z.string().optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
