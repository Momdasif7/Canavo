/**
 * Per-store integrations (Settings → Integrations): each business's own Razorpay, SMTP, MSG91 SMS and
 * WhatsApp accounts, managed by the owner in the app instead of server .env files.
 *
 * Storage: BusinessIntegration (row-level security per business). Non-secret settings live in `config`;
 * secrets are AES-256-GCM ciphertexts (lib/crypto.ts, DATA_ENCRYPTION_KEY) in `secrets`, one per field.
 * Secrets are decrypted only at the moment of use and never returned, logged, audited or exported:
 * the API shows "configured" plus a masked hint (last 4 characters, only for values of 8+ characters).
 */
import { randomBytes } from "node:crypto";
import type { BusinessIntegration, IntegrationKind, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { currentBusinessId } from "../lib/tenant";

export type { IntegrationKind };
export const INTEGRATION_KINDS = ["RAZORPAY", "SMTP", "SMS", "WHATSAPP"] as const satisfies readonly IntegrationKind[];

/** URL slugs (/integrations/:kind) ↔ kinds. */
export const SLUG_TO_KIND: Record<string, IntegrationKind> = { razorpay: "RAZORPAY", email: "SMTP", sms: "SMS", whatsapp: "WHATSAPP" };
export const KIND_TO_SLUG: Record<IntegrationKind, string> = { RAZORPAY: "razorpay", SMTP: "email", SMS: "sms", WHATSAPP: "whatsapp" };

/** The secret fields of each integration (write-only from the app's point of view). */
export const SECRET_FIELDS: Record<IntegrationKind, readonly string[]> = {
  RAZORPAY: ["keySecret", "webhookSecret"],
  SMTP: ["password"],
  SMS: ["authKey"],
  WHATSAPP: ["metaAccessToken", "watiToken"],
};

export interface LoadedIntegration {
  id: string;
  businessId: string;
  kind: IntegrationKind;
  enabled: boolean;
  config: Record<string, unknown>;
  webhookKey: string | null;
  updatedAt: Date;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  /** Is a value stored for this secret field? */
  has: (field: string) => boolean;
  /** Decrypted secret ("" when not set or undecryptable). Use it, never return or log it. */
  secret: (field: string) => string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function wrap(row: BusinessIntegration): LoadedIntegration {
  const secrets = obj(row.secrets) as Record<string, string>;
  const cache = new Map<string, string>();
  return {
    id: row.id,
    businessId: row.businessId,
    kind: row.kind,
    enabled: row.enabled,
    config: obj(row.config),
    webhookKey: row.webhookKey,
    updatedAt: row.updatedAt,
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestMessage: row.lastTestMessage,
    has: (f) => typeof secrets[f] === "string" && secrets[f]!.length > 0,
    secret: (f) => {
      if (cache.has(f)) return cache.get(f)!;
      const enc = secrets[f];
      let plain = "";
      if (typeof enc === "string" && enc) {
        try {
          plain = decrypt(enc);
        } catch {
          // Wrong DATA_ENCRYPTION_KEY or a damaged value: treat as not set (the owner re-enters it).
          console.warn(`[integrations] could not decrypt ${row.kind}.${f} for business ${row.businessId}`);
        }
      }
      cache.set(f, plain);
      return plain;
    },
  };
}

/** The business's integration of this kind (inside the business context, or for an explicit business id). */
export async function loadIntegration(kind: IntegrationKind, businessId = currentBusinessId()): Promise<LoadedIntegration | null> {
  if (!businessId) return null;
  const row = await prisma.businessIntegration.findFirst({ where: { businessId, kind } });
  return row ? wrap(row) : null;
}

export async function loadAll(businessId: string): Promise<Partial<Record<IntegrationKind, LoadedIntegration>>> {
  const rows = await prisma.businessIntegration.findMany({ where: { businessId } });
  return Object.fromEntries(rows.map((r) => [r.kind, wrap(r)]));
}

/** "••••abcd" for values of 8+ characters; shorter values only show that something is set. */
export const maskHint = (plain: string): string | null => (!plain ? null : plain.length >= 8 ? `••••${plain.slice(-4)}` : "••••");

/** Strip every known secret of the integration out of a text (provider errors sometimes echo them). */
export function redactor(...secrets: (string | undefined | null)[]) {
  const list = secrets.filter((s): s is string => Boolean(s && s.length >= 4));
  return (text: string) => list.reduce((t, s) => t.split(s).join("[redacted]"), text);
}

export interface SaveInput {
  enabled: boolean;
  config: Record<string, unknown>;
  /** field → new plaintext; undefined / "" = keep the stored value; null = remove it */
  secrets: Record<string, string | null | undefined>;
}

export interface SaveResult {
  row: LoadedIntegration;
  created: boolean;
  /** Names of non-secret settings that changed (values are never audited) */
  changed: string[];
  /** Names of secrets that were replaced or removed */
  secretsChanged: string[];
}

export async function saveIntegration(kind: IntegrationKind, businessId: string, input: SaveInput, userId: string | undefined): Promise<SaveResult> {
  const prev = await prisma.businessIntegration.findFirst({ where: { businessId, kind } });
  const prevSecrets = obj(prev?.secrets) as Record<string, string>;
  const prevConfig = obj(prev?.config);
  const secrets: Record<string, string> = { ...prevSecrets };
  const secretsChanged: string[] = [];
  for (const f of SECRET_FIELDS[kind]) {
    const v = input.secrets[f];
    if (v === null) {
      if (secrets[f]) secretsChanged.push(f);
      delete secrets[f];
    } else if (typeof v === "string" && v.length) {
      secrets[f] = encrypt(v);
      secretsChanged.push(f);
    }
  }
  const keys = new Set([...Object.keys(prevConfig), ...Object.keys(input.config)]);
  const changed = [...keys].filter((k) => JSON.stringify(prevConfig[k]) !== JSON.stringify(input.config[k]));
  if (prev && prev.enabled !== input.enabled) changed.push("enabled");
  const data = {
    enabled: input.enabled,
    config: input.config as Prisma.InputJsonValue,
    secrets: secrets as Prisma.InputJsonValue,
    updatedById: userId ?? null,
  };
  const row = prev
    ? await prisma.businessIntegration.update({ where: { id: prev.id }, data: { ...data, ...(kind === "RAZORPAY" && !prev.webhookKey && { webhookKey: newWebhookKey() }) } })
    : await prisma.businessIntegration.create({ data: { ...data, businessId, kind, ...(kind === "RAZORPAY" && { webhookKey: newWebhookKey() }) } });
  return { row: wrap(row), created: !prev, changed, secretsChanged };
}

/** 32 URL-safe characters (192 random bits): the per-store Razorpay webhook path. */
export const newWebhookKey = () => randomBytes(24).toString("base64url");

export async function rotateWebhookKey(id: string) {
  return wrap(await prisma.businessIntegration.update({ where: { id }, data: { webhookKey: newWebhookKey() } }));
}

export async function recordTest(id: string, ok: boolean, message: string) {
  await prisma.businessIntegration.update({ where: { id }, data: { lastTestedAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 300) } });
}

export const webhookUrl = (key: string) => `${env.PUBLIC_API_URL.replace(/\/+$/, "")}/webhooks/razorpay/${key}`;

// ---------------------------------------------------------------------------
// What each integration needs before it is used, and the platform fallback
// ---------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Enough is stored for the integration to be used for this business. */
export function isUsable(i: LoadedIntegration | null | undefined): boolean {
  if (!i || !i.enabled) return false;
  const c = i.config;
  switch (i.kind) {
    case "RAZORPAY":
      return Boolean(str(c.keyId) && i.has("keySecret"));
    case "SMTP":
      return Boolean(str(c.host) && str(c.fromEmail));
    case "SMS":
      return Boolean(i.has("authKey") && (str(c.alertTemplateId) || str(c.otpTemplateId)));
    case "WHATSAPP": {
      const provider = str(c.provider);
      if (provider === "META") return Boolean(str(obj(c.meta).phoneNumberId) && i.has("metaAccessToken"));
      if (provider === "WATI") return Boolean(str(obj(c.wati).apiUrl) && i.has("watiToken"));
      return false;
    }
  }
}

/** Is a platform-wide fallback configured on the server for this kind? */
export function platformFallback(kind: IntegrationKind): boolean {
  switch (kind) {
    case "RAZORPAY":
      return Boolean(env.RAZORPAY_SHARED_ACCOUNT && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
    case "SMTP":
      return Boolean(env.SMTP_HOST);
    case "SMS":
      return Boolean(env.MSG91_AUTH_KEY && (env.MSG91_ALERT_TEMPLATE_ID || env.MSG91_TEMPLATE_ID));
    case "WHATSAPP":
      return Boolean(env.WATI_API_URL && env.WATI_API_TOKEN);
  }
}

// ---------------------------------------------------------------------------
// API views (never a secret; managers get status only)
// ---------------------------------------------------------------------------

export type Source = "business" | "platform" | "none";

export interface StatusView {
  kind: IntegrationKind;
  slug: string;
  configured: boolean;
  enabled: boolean;
  /** What is used right now: this store's own account, the platform's fallback, or nothing (dev / mock / click-to-chat) */
  source: Source;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  updatedAt: Date | null;
}

export function statusView(kind: IntegrationKind, i: LoadedIntegration | null | undefined): StatusView {
  const usable = isUsable(i);
  return {
    kind,
    slug: KIND_TO_SLUG[kind],
    configured: usable,
    enabled: i?.enabled ?? false,
    source: usable ? "business" : platformFallback(kind) && !(kind === "WHATSAPP" && i) ? "platform" : "none",
    lastTestedAt: i?.lastTestedAt ?? null,
    lastTestOk: i?.lastTestOk ?? null,
    updatedAt: i?.updatedAt ?? null,
  };
}

/** Razorpay key ids are public (they appear in checkout) but are still shown shortened. */
const maskKeyId = (id: string) => {
  const m = id.match(/^(rzp_(?:test|live)_)(.*)$/);
  return m ? `${m[1]}••••${m[2]!.slice(-4)}` : maskHint(id);
};

/** The owner's view: settings, masked secret hints, last test outcome, the store's webhook URL. */
export function ownerView(kind: IntegrationKind, i: LoadedIntegration | null | undefined) {
  const c = i?.config ?? {};
  const secrets = Object.fromEntries(SECRET_FIELDS[kind].map((f) => [f, { set: Boolean(i?.has(f)), hint: i?.has(f) ? maskHint(i.secret(f)) : null }]));
  let config: Record<string, unknown>;
  switch (kind) {
    case "RAZORPAY": {
      const keyId = str(c.keyId);
      config = { keyId: keyId ? maskKeyId(keyId) : null, mode: keyId.startsWith("rzp_live_") ? "live" : keyId ? "test" : null };
      break;
    }
    case "SMTP":
      config = { host: c.host ?? null, port: c.port ?? null, secure: c.secure ?? null, user: c.user ?? null, fromEmail: c.fromEmail ?? null, fromName: c.fromName ?? null };
      break;
    case "SMS":
      config = { senderId: c.senderId ?? null, otpTemplateId: c.otpTemplateId ?? null, alertTemplateId: c.alertTemplateId ?? null };
      break;
    case "WHATSAPP": {
      const meta = obj(c.meta);
      const wati = obj(c.wati);
      config = {
        provider: str(c.provider) || "NONE",
        meta: c.meta ? { phoneNumberId: meta.phoneNumberId ?? null, language: meta.language ?? "en" } : null,
        wati: c.wati ? { apiUrl: wati.apiUrl ?? null } : null,
        autoDeliveryUpdates: c.autoDeliveryUpdates === true,
        staffAlerts: c.staffAlerts === true,
      };
      break;
    }
  }
  return {
    ...statusView(kind, i),
    config,
    secrets,
    lastTestMessage: i?.lastTestMessage ?? null,
    platformFallbackAvailable: platformFallback(kind),
    ...(kind === "RAZORPAY" && { webhookUrl: i?.webhookKey ? webhookUrl(i.webhookKey) : null }),
  };
}
