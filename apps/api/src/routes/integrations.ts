import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { integrationTestPhoneSchema, maskSecret, razorpayIntegrationSchema, smsIntegrationSchema, smtpIntegrationSchema } from "@canavo/shared";
import { platformPrisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, forbidden, parse } from "../lib/http";
import { authenticate, requireBusiness, requirePermission } from "../middleware/auth";
import { superAdminIpWhitelist } from "../middleware/ip-whitelist";
import {
  openSecret,
  platformSmtp,
  RAZORPAY_HOOK_KEY,
  RAZORPAY_KEY,
  razorpayWebhookId,
  razorpayWebhookUrl,
  readStored,
  sealSecret,
  SMS_KEY,
  smsFor,
  smtpHostError,
  SMTP_KEY,
  storeRazorpay,
  storeSms,
  storeSmtp,
  writeStored,
  type StoredRazorpay,
  type StoredSms,
  type StoredSmtp,
} from "../services/integrations";
import { testRazorpay } from "../services/razorpay";
import { testSmtp } from "../services/mailer";
import { testSms } from "../services/sms";
import { getStoredConfig, getWaConfig } from "../services/whatsapp";

/**
 * Settings → Integrations (owner only): the store's own Razorpay, email (SMTP) and SMS (MSG91)
 * accounts. Secrets are write-only (encrypted at rest, masked in every answer, never audited);
 * a blank secret on save keeps the saved one. WhatsApp keeps its own endpoints (/admin/whatsapp).
 */
export const integrationsRouter = Router();
integrationsRouter.use(authenticate, superAdminIpWhitelist, requireBusiness, requirePermission("outlet:manage"));
integrationsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  // Support views act as a manager and are already refused above; say so plainly anyway.
  if (req.support) throw forbidden("Integrations aren't available in a support view");
  next();
});

/**
 * "Test connection" buttons: per store and integration, 10 per 15 minutes. Keyed by business
 * (not IP), so many devices or spoofed addresses don't add up to more tries.
 */
export const integrationTestLimiter = (kind: string) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `integration-test:${kind}:${req.businessId ?? "none"}`,
    message: { error: "Too many tests. Wait a few minutes and try again." },
  });

const bizId = (req: Request) => req.businessId!;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function razorpayView(businessId: string) {
  const creds = await storeRazorpay(businessId);
  return {
    connected: Boolean(creds),
    keyId: maskSecret(creds?.keyId),
    keySecret: maskSecret(creds?.keySecret),
    webhookSecret: maskSecret(creds?.webhookSecret),
    mode: creds ? (creds.keyId.startsWith("rzp_live_") ? "live" : "test") : null,
    webhookUrl: razorpayWebhookUrl(businessId),
    /** Without its own account a store has no online UPI: money must never land in the platform's account. */
    platformFallback: false as const,
  };
}

async function smtpView(businessId: string) {
  const s = await storeSmtp(businessId);
  return {
    connected: Boolean(s),
    host: s?.host ?? null,
    port: s?.port ?? null,
    secure: s?.secure ?? null,
    user: s?.user ?? null,
    password: maskSecret(s?.pass),
    from: s?.from ?? null,
    platformFallback: Boolean(platformSmtp()),
  };
}

async function smsView(businessId: string) {
  const s = await storeSms(businessId);
  const [otp, alert] = [await smsFor("otp", businessId), await smsFor("alert", businessId)];
  return {
    connected: Boolean(s),
    authKey: maskSecret(s?.authKey),
    otpTemplateId: s?.otpTemplateId ?? null,
    alertTemplateId: s?.alertTemplateId ?? null,
    /** Which account each kind of SMS uses right now */
    using: { otp: otp?.source ?? null, alert: alert?.source ?? null },
  };
}

async function whatsappView(businessId: string) {
  const stored = await getStoredConfig(businessId);
  const cfg = await getWaConfig(businessId);
  return { provider: cfg.provider, connected: cfg.provider !== "NONE", fromEnv: cfg.fromEnv, saved: Boolean(stored) };
}

integrationsRouter.get("/", async (req, res) => {
  const id = bizId(req);
  res.json({ razorpay: await razorpayView(id), smtp: await smtpView(id), sms: await smsView(id), whatsapp: await whatsappView(id) });
});

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

integrationsRouter.put("/razorpay", async (req, res) => {
  const data = parse(razorpayIntegrationSchema, req.body ?? {});
  const id = bizId(req);
  const prev = await readStored<StoredRazorpay>(id, RAZORPAY_KEY);
  const prevKeyId = openSecret(prev?.keyIdEnc);
  if (data.keyId && data.keyId !== prevKeyId && !data.keySecret) throw badRequest("Enter the key secret for this key ID");
  if (!(data.keyId || prevKeyId) || !(data.keySecret || prev?.keySecretEnc)) throw badRequest("Enter the key ID and key secret");
  const webhookId = razorpayWebhookId(id);
  const value: StoredRazorpay = {
    keyIdEnc: data.keyId ? sealSecret(data.keyId) : prev!.keyIdEnc,
    keySecretEnc: data.keySecret ? sealSecret(data.keySecret) : prev!.keySecretEnc,
    webhookSecretEnc: data.webhookSecret ? sealSecret(data.webhookSecret) : prev?.webhookSecretEnc,
    webhookId,
  };
  await writeStored(id, RAZORPAY_KEY, value);
  // Index for the per-store webhook URL → this business.
  await writeStored(`rzphook:${webhookId}`, RAZORPAY_HOOK_KEY, { businessId: id });
  await audit(req, "integration.razorpay.update", "Setting", RAZORPAY_KEY, {
    changed: (["keyId", "keySecret", "webhookSecret"] as const).filter((k) => data[k]),
    mode: (data.keyId ?? prevKeyId).startsWith("rzp_live_") ? "live" : "test",
  });
  res.json(await razorpayView(id));
});

integrationsRouter.delete("/razorpay", async (req, res) => {
  const id = bizId(req);
  await writeStored(id, RAZORPAY_KEY, null);
  await platformPrisma.setting.deleteMany({ where: { scope: `rzphook:${razorpayWebhookId(id)}`, key: RAZORPAY_HOOK_KEY } });
  await audit(req, "integration.razorpay.remove", "Setting", RAZORPAY_KEY);
  res.json(await razorpayView(id));
});

integrationsRouter.post("/razorpay/test", integrationTestLimiter("razorpay"), async (req, res) => {
  const creds = await storeRazorpay(bizId(req));
  if (!creds) throw badRequest("Save your Razorpay keys first");
  const result = await testRazorpay(creds);
  await audit(req, "integration.razorpay.test", "Setting", RAZORPAY_KEY, { ok: result.ok });
  res.json({ ...result, webhookSecret: Boolean(creds.webhookSecret) });
});

// ---------------------------------------------------------------------------
// Email (SMTP)
// ---------------------------------------------------------------------------

integrationsRouter.put("/smtp", async (req, res) => {
  const data = parse(smtpIntegrationSchema, req.body ?? {});
  const hostProblem = smtpHostError(data.host);
  if (hostProblem) throw badRequest(hostProblem);
  const id = bizId(req);
  const prev = await readStored<StoredSmtp>(id, SMTP_KEY);
  const value: StoredSmtp = {
    host: data.host,
    port: data.port,
    secure: data.secure ?? data.port === 465,
    user: data.user,
    // No user name = no login, so no password either.
    passEnc: !data.user ? undefined : data.password ? sealSecret(data.password) : prev?.passEnc,
    from: data.from,
  };
  await writeStored(id, SMTP_KEY, value);
  await audit(req, "integration.smtp.update", "Setting", SMTP_KEY, {
    host: value.host,
    port: value.port,
    secure: value.secure,
    passwordChanged: Boolean(data.password),
  });
  res.json(await smtpView(id));
});

integrationsRouter.delete("/smtp", async (req, res) => {
  const id = bizId(req);
  await writeStored(id, SMTP_KEY, null);
  await audit(req, "integration.smtp.remove", "Setting", SMTP_KEY);
  res.json(await smtpView(id));
});

integrationsRouter.post("/smtp/test", integrationTestLimiter("smtp"), async (req, res) => {
  const smtp = await storeSmtp(bizId(req));
  if (!smtp) throw badRequest("Save your mail server first");
  const result = await testSmtp(smtp);
  await audit(req, "integration.smtp.test", "Setting", SMTP_KEY, { ok: result.ok });
  res.json(result);
});

// ---------------------------------------------------------------------------
// SMS (MSG91)
// ---------------------------------------------------------------------------

integrationsRouter.put("/sms", async (req, res) => {
  const data = parse(smsIntegrationSchema, req.body ?? {});
  const id = bizId(req);
  const prev = await readStored<StoredSms>(id, SMS_KEY);
  if (!data.authKey && !prev?.authKeyEnc) throw badRequest("Enter the MSG91 auth key");
  if (!data.otpTemplateId && !data.alertTemplateId) throw badRequest("Enter the OTP template ID, the alert template ID, or both");
  const value: StoredSms = {
    authKeyEnc: data.authKey ? sealSecret(data.authKey) : prev!.authKeyEnc,
    otpTemplateId: data.otpTemplateId,
    alertTemplateId: data.alertTemplateId,
  };
  await writeStored(id, SMS_KEY, value);
  await audit(req, "integration.sms.update", "Setting", SMS_KEY, {
    authKeyChanged: Boolean(data.authKey),
    otpTemplateId: value.otpTemplateId ?? null,
    alertTemplateId: value.alertTemplateId ?? null,
  });
  res.json(await smsView(id));
});

integrationsRouter.delete("/sms", async (req, res) => {
  const id = bizId(req);
  await writeStored(id, SMS_KEY, null);
  await audit(req, "integration.sms.remove", "Setting", SMS_KEY);
  res.json(await smsView(id));
});

/** Sends one alert SMS (MSG91 has no harmless check call) to a number the owner typed. */
integrationsRouter.post("/sms/test", integrationTestLimiter("sms"), async (req, res) => {
  const { phone } = parse(integrationTestPhoneSchema, req.body ?? {});
  const s = await storeSms(bizId(req));
  if (!s) throw badRequest("Save your MSG91 auth key first");
  if (!s.alertTemplateId) throw badRequest("Add the alert template ID to send a test SMS");
  const result = await testSms({ authKey: s.authKey, templateId: s.alertTemplateId, source: "store" }, phone.slice(-10));
  await audit(req, "integration.sms.test", "Setting", SMS_KEY, { ok: result.ok });
  res.json(result);
});
