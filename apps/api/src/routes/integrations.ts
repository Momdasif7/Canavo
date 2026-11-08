/**
 * Settings → Integrations: each store's own Razorpay, email (SMTP), SMS (MSG91) and WhatsApp accounts,
 * and Settings → WhatsApp templates.
 *
 * Who: the owner (outlet:manage) reads masked settings, edits and tests. Managers (settings:outlet) see
 * status only (configured / source / last test) and the WhatsApp template list. Platform accounts and
 * support views get nothing here (secrets are the store's alone). Secrets are write-only: an empty field
 * keeps the stored value. Every change is audited by field NAME, never value.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { IntegrationKind } from "@prisma/client";
import { audit } from "../lib/audit";
import { badRequest, forbidden, notFound, param, parse } from "../lib/http";
import { requireBusinessId } from "../lib/tenant";
import { authenticate, requireBusiness, requirePermission, userCan } from "../middleware/auth";
import {
  INTEGRATION_KINDS,
  KIND_TO_SLUG,
  SLUG_TO_KIND,
  isUsable,
  loadAll,
  loadIntegration,
  ownerView,
  recordTest,
  rotateWebhookKey,
  saveIntegration,
  statusView,
  type LoadedIntegration,
} from "../services/integrations";
import { smtpHostError, testStoreSmtp } from "../services/mailer";
import { testRazorpayKeys } from "../services/razorpay";
import { testStoreSms } from "../services/sms";
import {
  DEFAULT_TEMPLATES,
  WA_PURPOSES,
  WA_TEMPLATE_CATALOG,
  checkWhatsAppCredentials,
  getWaConfig,
  getWaIntegration,
  renderTemplate,
  sendWhatsApp,
  templateSettings,
  type StoredWaConfig,
  type WaPurpose,
  type WaTemplateSetting,
} from "../services/whatsapp";

export const integrationsRouter = Router();

/** Secrets never reach a support view (read-only platform access granted by the owner), even masked. */
export function noSupport(req: Request, _res: Response, next: NextFunction) {
  if (req.support) throw forbidden("Integrations aren't available in a support view");
  next();
}

integrationsRouter.use(authenticate, requireBusiness, noSupport);

const isOwner = (req: Request) => userCan(req, "outlet:manage");

/** Connection tests reach third parties (and may send a real SMS / email / WhatsApp): 10 per 15 min per person and integration. */
const testLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `${req.user?.id ?? "anon"}:${req.params.kind ?? `wa-template`}`,
  message: { error: "Too many tests — wait a few minutes and try again" },
});

function kindOf(req: Request): IntegrationKind {
  const kind = SLUG_TO_KIND[param(req, "kind")];
  if (!kind) throw notFound("Integration");
  return kind;
}

// ---------------------------------------------------------------------------
// Validation per integration ("" = not entered = keep the stored secret)
// ---------------------------------------------------------------------------

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optSecret = (min: number, max: number, msg?: string) => z.preprocess(blankToUndef, z.string().trim().min(min, msg).max(max).optional());
const optText = (max: number) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());

const razorpaySchema = z.object({
  enabled: z.boolean().default(true),
  /** Omit to keep the saved key id */
  keyId: z.preprocess(blankToUndef, z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, "Key ID looks like rzp_live_XXXXXXXX or rzp_test_XXXXXXXX (Razorpay Dashboard → Account & Settings → API Keys)").optional()),
  keySecret: optSecret(8, 200, "Key secret is too short"),
  webhookSecret: optSecret(6, 200, "Webhook secret is too short"),
});

const emailSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().optional(),
  user: optText(254),
  password: optSecret(1, 500),
  fromEmail: z.string().trim().email("Enter the address emails are sent from").max(254),
  fromName: optText(100),
});

const templateId = z.preprocess(blankToUndef, z.string().trim().regex(/^[A-Za-z0-9]{6,40}$/, "Template ID is the id from MSG91 → Templates (letters and digits)").optional());
const smsSchema = z.object({
  enabled: z.boolean().default(true),
  authKey: z.preprocess(blankToUndef, z.string().trim().regex(/^[A-Za-z0-9]{10,64}$/, "Auth key is the key from MSG91 → API (letters and digits)").optional()),
  senderId: z.preprocess(blankToUndef, z.string().trim().regex(/^[A-Z]{6}$/, "Sender ID is the 6-letter DLT header, e.g. CANAVO").optional()),
  otpTemplateId: templateId,
  alertTemplateId: templateId,
});

const waTemplatesSchema = z.object(
  Object.fromEntries(WA_PURPOSES.map((p) => [p, z.string().trim().max(512).optional()])) as Record<WaPurpose, z.ZodOptional<z.ZodString>>,
);
export const waConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["NONE", "META", "WATI"]),
  meta: z
    .object({
      phoneNumberId: z.string().trim().regex(/^\d{6,20}$/, "Phone number ID is the numeric id from Meta's WhatsApp → API setup page"),
      /** Omit to keep the saved token */
      accessToken: z.preprocess(blankToUndef, z.string().trim().min(20).max(1024).optional()),
      language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Template language code, e.g. en or en_US").default("en"),
    })
    .optional(),
  wati: z
    .object({
      apiUrl: z.string().trim().url().refine((u) => u.startsWith("https://"), "WATI API URL must start with https://"),
      token: z.preprocess(blankToUndef, z.string().trim().min(10).max(2048).optional()),
    })
    .optional(),
  /** Legacy /admin/whatsapp: template names per purpose (Settings → WhatsApp templates edits name + language) */
  templates: waTemplatesSchema.optional(),
  autoDeliveryUpdates: z.boolean().default(false),
  staffAlerts: z.boolean().default(false),
});

const need = (cond: unknown, msg: string) => {
  if (!cond) throw badRequest(msg);
};

/** Save the store's WhatsApp setup (shared with the older /admin/whatsapp endpoint). */
export async function saveWhatsApp(req: Request, body: unknown) {
  const data = parse(waConfigSchema, body);
  const businessId = requireBusinessId();
  const { row: prev, stored } = await getWaIntegration(businessId);
  if (data.provider === "META") {
    need(data.meta, "Enter the Meta phone number ID and access token");
    need(data.meta!.accessToken || prev?.has("metaAccessToken"), "Enter the Meta access token");
  }
  if (data.provider === "WATI") {
    need(data.wati, "Enter the WATI API URL and token");
    need(data.wati!.token || prev?.has("watiToken"), "Enter the WATI API token");
  }
  const templates = templateSettings(stored);
  if (data.templates) {
    for (const p of WA_PURPOSES) {
      const name = data.templates[p];
      templates[p] = { ...templates[p], name: name || undefined };
    }
  }
  const config: StoredWaConfig = {
    provider: data.provider,
    meta: data.meta ? { phoneNumberId: data.meta.phoneNumberId, language: data.meta.language } : stored?.meta,
    wati: data.wati ? { apiUrl: data.wati.apiUrl } : stored?.wati,
    templates: compactTemplates(templates),
    autoDeliveryUpdates: data.autoDeliveryUpdates,
    staffAlerts: data.staffAlerts,
  };
  const result = await saveIntegration(
    "WHATSAPP",
    businessId,
    { enabled: data.enabled, config: JSON.parse(JSON.stringify(config)), secrets: { metaAccessToken: data.meta?.accessToken, watiToken: data.wati?.token } },
    req.user?.id,
  );
  await auditSave(req, "WHATSAPP", result);
  return result.row;
}

function compactTemplates(t: Record<WaPurpose, WaTemplateSetting>) {
  const out: Partial<Record<WaPurpose, WaTemplateSetting>> = {};
  for (const p of WA_PURPOSES) {
    const v = Object.fromEntries(Object.entries(t[p]).filter(([, x]) => typeof x === "string" && x)) as WaTemplateSetting;
    if (Object.keys(v).length) out[p] = v;
  }
  return out;
}

async function auditSave(req: Request, kind: IntegrationKind, r: { created: boolean; changed: string[]; secretsChanged: string[]; row: LoadedIntegration }) {
  // Names of what changed, never values (secret or not).
  await audit(req, r.created ? "integration.create" : "integration.update", "BusinessIntegration", r.row.id, {
    kind,
    changed: r.changed,
    secretsChanged: r.secretsChanged,
    enabled: r.row.enabled,
  });
}

async function saveKind(req: Request, kind: IntegrationKind) {
  const businessId = requireBusinessId();
  if (kind === "WHATSAPP") return saveWhatsApp(req, req.body);
  const prev = await loadIntegration(kind, businessId);
  if (kind === "RAZORPAY") {
    const d = parse(razorpaySchema, req.body);
    const keyId = d.keyId ?? (typeof prev?.config.keyId === "string" ? prev.config.keyId : undefined);
    need(keyId, "Enter the key ID");
    need(d.keySecret || prev?.has("keySecret"), "Enter the key secret");
    const r = await saveIntegration(kind, businessId, { enabled: d.enabled, config: { keyId }, secrets: { keySecret: d.keySecret, webhookSecret: d.webhookSecret } }, req.user?.id);
    await auditSave(req, kind, r);
    return r.row;
  }
  if (kind === "SMTP") {
    const d = parse(emailSchema, req.body);
    const reason = smtpHostError(d.host, d.port);
    if (reason) throw badRequest(reason);
    need(!d.user || d.password || prev?.has("password"), "Enter the SMTP password");
    const config = { host: d.host.toLowerCase(), port: d.port, secure: d.secure ?? d.port === 465, user: d.user, fromEmail: d.fromEmail, fromName: d.fromName };
    const r = await saveIntegration(kind, businessId, { enabled: d.enabled, config: JSON.parse(JSON.stringify(config)), secrets: { password: d.user ? d.password : null } }, req.user?.id);
    await auditSave(req, kind, r);
    return r.row;
  }
  const d = parse(smsSchema, req.body);
  need(d.authKey || prev?.has("authKey"), "Enter the MSG91 auth key");
  need(d.otpTemplateId || d.alertTemplateId, "Enter at least one template ID (OTP or alert)");
  const config = { senderId: d.senderId, otpTemplateId: d.otpTemplateId, alertTemplateId: d.alertTemplateId };
  const r = await saveIntegration(kind, businessId, { enabled: d.enabled, config: JSON.parse(JSON.stringify(config)), secrets: { authKey: d.authKey } }, req.user?.id);
  await auditSave(req, kind, r);
  return r.row;
}

// ---------------------------------------------------------------------------
// WhatsApp templates (before /:kind so "whatsapp/templates" isn't read as a kind)
// ---------------------------------------------------------------------------

export const META_TEMPLATES_URL = "https://business.facebook.com/wa/manage/message-templates/";

async function templatesView(req: Request) {
  const businessId = requireBusinessId();
  const { stored } = await getWaIntegration(businessId);
  const cfg = await getWaConfig(businessId);
  const settings = templateSettings(stored);
  const defaultLanguage = stored?.meta?.language || "en";
  return {
    provider: cfg.provider,
    editable: isOwner(req),
    defaultLanguage,
    metaManagerUrl: META_TEMPLATES_URL,
    purposes: WA_PURPOSES.map((p) => {
      const c = WA_TEMPLATE_CATALOG[p];
      const s = settings[p];
      const name = s.name || DEFAULT_TEMPLATES[p];
      const variables = p === "test" && name === "hello_world" ? [] : c.variables;
      return {
        purpose: p,
        label: c.label,
        description: c.description,
        category: c.category,
        variables,
        suggestedBody: c.suggestedBody,
        defaultName: DEFAULT_TEMPLATES[p],
        name: s.name ?? null,
        language: s.language ?? null,
        body: s.body ?? null,
        effectiveName: name,
        effectiveLanguage: s.language || defaultLanguage,
        preview: renderTemplate(s.body || c.suggestedBody, variables.map((v) => v.sample)),
      };
    }),
  };
}

integrationsRouter.get("/whatsapp/templates", requirePermission("settings:outlet"), async (req, res) => {
  res.json(await templatesView(req));
});

const templateSettingSchema = z
  .object({
    name: z.preprocess(blankToUndef, z.string().trim().regex(/^[A-Za-z0-9_.-]{1,512}$/, "Template name as approved in WhatsApp Manager, e.g. order_receipt (letters, digits, _)").optional()),
    language: z.preprocess(blankToUndef, z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Language code, e.g. en, en_US or hi").optional()),
    body: z.preprocess(blankToUndef, z.string().max(1024).optional()),
  })
  .strict();
const templatesPutSchema = z.object({
  templates: z.object(Object.fromEntries(WA_PURPOSES.map((p) => [p, templateSettingSchema.optional()])) as Record<WaPurpose, z.ZodOptional<typeof templateSettingSchema>>).strict(),
});

integrationsRouter.put("/whatsapp/templates", requirePermission("outlet:manage"), async (req, res) => {
  const { templates } = parse(templatesPutSchema, req.body);
  const businessId = requireBusinessId();
  const { row, stored } = await getWaIntegration(businessId);
  const current = templateSettings(stored);
  for (const p of WA_PURPOSES) if (templates[p]) current[p] = templates[p]!;
  const config = { ...(stored ?? { provider: "NONE" }), templates: compactTemplates(current) };
  const r = await saveIntegration("WHATSAPP", businessId, { enabled: row?.enabled ?? true, config: JSON.parse(JSON.stringify(config)), secrets: {} }, req.user?.id);
  await audit(req, "whatsapp.templates", "BusinessIntegration", r.row.id, { purposes: WA_PURPOSES.filter((p) => templates[p]) });
  res.json(await templatesView(req));
});

const phoneSchema = z.object({ phone: z.string().trim().regex(/^(\+?91)?[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number") });

/** Send one message type with its sample values to a phone, through the store's WhatsApp. */
integrationsRouter.post("/whatsapp/templates/:purpose/test", requirePermission("outlet:manage"), testLimiter, async (req, res) => {
  const purpose = param(req, "purpose") as WaPurpose;
  if (!WA_PURPOSES.includes(purpose)) throw notFound("Message type");
  const { phone } = parse(phoneSchema, req.body);
  const businessId = requireBusinessId();
  const { stored } = await getWaIntegration(businessId);
  const cfg = await getWaConfig(businessId);
  const c = WA_TEMPLATE_CATALOG[purpose];
  const body = templateSettings(stored)[purpose].body || c.suggestedBody;
  const result = await sendWhatsApp(
    { to: phone.slice(-10), text: renderTemplate(body, c.variables.map((v) => v.sample)), purpose, tag: `canavo_test_${purpose}`, params: c.variables.map((v) => ({ name: v.name, value: v.sample })) },
    cfg,
  );
  await audit(req, "whatsapp.template_test", "BusinessIntegration", purpose, { purpose, provider: result.provider, method: result.method });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

integrationsRouter.get("/", requirePermission("settings:outlet"), async (req, res) => {
  const all = await loadAll(requireBusinessId());
  const owner = isOwner(req);
  res.json({ items: INTEGRATION_KINDS.map((k) => (owner ? ownerView(k, all[k]) : statusView(k, all[k]))), editable: owner });
});

integrationsRouter.get("/:kind", requirePermission("settings:outlet"), async (req, res) => {
  const kind = kindOf(req);
  const i = await loadIntegration(kind, requireBusinessId());
  res.json(isOwner(req) ? ownerView(kind, i) : statusView(kind, i));
});

integrationsRouter.put("/:kind", requirePermission("outlet:manage"), async (req, res) => {
  const kind = kindOf(req);
  const row = await saveKind(req, kind);
  res.json(ownerView(kind, await loadIntegration(kind, row.businessId)));
});

/** Remove the store's own account (the platform fallback, if any, is used again). */
integrationsRouter.delete("/:kind", requirePermission("outlet:manage"), async (req, res) => {
  const kind = kindOf(req);
  const i = await loadIntegration(kind, requireBusinessId());
  if (!i) throw notFound("Integration");
  const { prisma } = await import("../db");
  await prisma.businessIntegration.delete({ where: { id: i.id } });
  await audit(req, "integration.delete", "BusinessIntegration", i.id, { kind });
  res.status(204).end();
});

/** New webhook URL for the store (e.g. the old one leaked); paste it into Razorpay again. */
integrationsRouter.post("/razorpay/webhook-key", requirePermission("outlet:manage"), async (req, res) => {
  const i = await loadIntegration("RAZORPAY", requireBusinessId());
  if (!i) throw badRequest("Save your Razorpay keys first");
  const r = await rotateWebhookKey(i.id);
  await audit(req, "integration.webhook_key_rotated", "BusinessIntegration", i.id, { kind: "RAZORPAY" });
  res.json(ownerView("RAZORPAY", r));
});

const testSchema = z.object({
  phone: z.preprocess(blankToUndef, z.string().trim().regex(/^(\+?91)?[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number").optional()),
  to: z.preprocess(blankToUndef, z.string().trim().email("Enter an email address").max(254).optional()),
});

integrationsRouter.post("/:kind/test", requirePermission("outlet:manage"), testLimiter, async (req, res) => {
  const kind = kindOf(req);
  const { phone, to } = parse(testSchema, req.body ?? {});
  const i = await loadIntegration(kind, requireBusinessId());
  if (!i) throw badRequest(`Save your ${KIND_TO_SLUG[kind] === "email" ? "email" : KIND_TO_SLUG[kind]} settings first`);
  let out: { ok: boolean; message: string; waLink?: string };
  if (kind === "RAZORPAY") {
    if (!isUsable(i)) throw badRequest("Enter the key ID and key secret first");
    out = await testRazorpayKeys(String(i.config.keyId), i.secret("keySecret"));
    if (out.ok && !i.has("webhookSecret")) out.message += ". Add the webhook secret so payments confirm automatically";
  } else if (kind === "SMTP") {
    out = await testStoreSmtp(i, to);
  } else if (kind === "SMS") {
    if (!phone) throw badRequest("Enter a mobile number to receive the test SMS");
    const c = i.config as { otpTemplateId?: string; alertTemplateId?: string };
    out = await testStoreSms({ authKey: i.secret("authKey"), otpTemplateId: c.otpTemplateId, alertTemplateId: c.alertTemplateId }, phone);
  } else {
    const cfg = await getWaConfig(i.businessId);
    if (cfg.provider === "NONE") throw badRequest("Choose Meta or WATI and save first (click-to-chat needs no test)");
    if (phone) {
      const r = await sendWhatsApp({ to: phone.slice(-10), text: "Test message from CANAVO: WhatsApp is connected.", purpose: "test", tag: "canavo_test", params: [{ name: "message", value: "WhatsApp is connected" }] }, cfg);
      out = r.method === "sent" ? { ok: true, message: `Sent a test message through ${r.provider === "META" ? "Meta" : "WATI"}` } : { ok: false, message: r.error ?? "Not sent", waLink: r.waLink };
    } else {
      out = await checkWhatsAppCredentials(cfg);
    }
  }
  await recordTest(i.id, out.ok, out.message);
  await audit(req, "integration.test", "BusinessIntegration", i.id, { kind, ok: out.ok });
  res.json({ ...out, testedAt: new Date() });
});
