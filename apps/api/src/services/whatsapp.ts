import { prisma } from "../db";
import { env } from "../env";
import { dataKey, decryptWith, encryptWith } from "../lib/crypto";
import { currentBusinessId } from "../lib/tenant";

/**
 * WhatsApp messaging for a business.
 *
 * Each business picks a provider in Settings → WhatsApp:
 *  - META: the official WhatsApp Cloud API (phone number id + access token),
 *  - WATI: a WATI account (API URL + token),
 *  - NONE: no API; every message is a wa.me click-to-chat link staff open.
 * Business-initiated messages must use templates approved in the provider's
 * console; template names per purpose are configurable. Any API failure falls
 * back to the click-to-chat link, so sending never blocks the caller.
 * Tokens are stored encrypted (AES-256-GCM, DATA_ENCRYPTION_KEY).
 */

export type WaProvider = "NONE" | "META" | "WATI";
export const WA_PURPOSES = ["receipt", "khata_reminder", "birthday", "anniversary", "delivery_update", "staff_alert", "test"] as const;
export type WaPurpose = (typeof WA_PURPOSES)[number];

/** Template names used when the business hasn't set its own (create/approve these in Meta / WATI). */
export const DEFAULT_TEMPLATES: Record<WaPurpose, string> = {
  receipt: env.WATI_RECEIPT_TEMPLATE,
  khata_reminder: "khata_reminder",
  birthday: "birthday_wish",
  anniversary: "anniversary_wish",
  delivery_update: "delivery_update",
  staff_alert: "staff_alert",
  test: "hello_world",
};

/** As stored in Setting(scope = businessId, key = "whatsapp.config"). */
export interface StoredWaConfig {
  provider: WaProvider;
  meta?: { phoneNumberId: string; accessTokenEnc?: string; language?: string };
  wati?: { apiUrl: string; tokenEnc?: string };
  templates?: Partial<Record<WaPurpose, string>>;
  /** Language of each approved template when it differs from meta.language (Meta needs the exact code) */
  templateLanguages?: Partial<Record<WaPurpose, string>>;
  /** Send delivery status updates to customers automatically */
  autoDeliveryUpdates?: boolean;
  /** Allow staff alerts on WhatsApp (each person still opts in under notification preferences) */
  staffAlerts?: boolean;
}

export interface WaConfig {
  provider: WaProvider;
  /** baseUrl: Graph API origin override (tests / a proxy); defaults to WHATSAPP_META_BASE_URL */
  meta?: { phoneNumberId: string; accessToken: string; language: string; baseUrl?: string };
  wati?: { apiUrl: string; token: string };
  templates: Record<WaPurpose, string>;
  /** Per-purpose template language (Meta); missing = meta.language */
  templateLanguages?: Partial<Record<WaPurpose, string>>;
  autoDeliveryUpdates: boolean;
  staffAlerts: boolean;
  /** Config comes from server env (WATI_*) because the business has none */
  fromEnv: boolean;
}

export const WA_SETTING_KEY = "whatsapp.config";

export const encryptSecret = (plain: string) => encryptWith(dataKey(), plain);
export const decryptSecret = (enc?: string) => {
  if (!enc) return "";
  try {
    return decryptWith(dataKey(), enc);
  } catch {
    return "";
  }
};

export async function getStoredConfig(businessId: string): Promise<StoredWaConfig | null> {
  const row = await prisma.setting.findUnique({ where: { scope_key: { scope: businessId, key: WA_SETTING_KEY } } });
  return (row?.value as unknown as StoredWaConfig | undefined) ?? null;
}

export async function getWaConfig(businessId = currentBusinessId()): Promise<WaConfig> {
  const stored = businessId ? await getStoredConfig(businessId) : null;
  const templates = { ...DEFAULT_TEMPLATES, ...(stored?.templates ?? {}) };
  if (stored && stored.provider !== "NONE") {
    return {
      provider: stored.provider,
      meta: stored.meta ? { phoneNumberId: stored.meta.phoneNumberId, accessToken: decryptSecret(stored.meta.accessTokenEnc), language: stored.meta.language || "en" } : undefined,
      wati: stored.wati ? { apiUrl: stored.wati.apiUrl.replace(/\/$/, ""), token: decryptSecret(stored.wati.tokenEnc) } : undefined,
      templates,
      templateLanguages: stored.templateLanguages ?? {},
      autoDeliveryUpdates: stored.autoDeliveryUpdates ?? false,
      staffAlerts: stored.staffAlerts ?? false,
      fromEnv: false,
    };
  }
  if (!stored && env.WATI_API_URL && env.WATI_API_TOKEN) {
    return { provider: "WATI", wati: { apiUrl: env.WATI_API_URL.replace(/\/$/, ""), token: env.WATI_API_TOKEN }, templates, autoDeliveryUpdates: false, staffAlerts: false, fromEnv: true };
  }
  return { provider: "NONE", templates, templateLanguages: stored?.templateLanguages ?? {}, autoDeliveryUpdates: stored?.autoDeliveryUpdates ?? false, staffAlerts: stored?.staffAlerts ?? false, fromEnv: false };
}

/** Indian mobile → WhatsApp id: 10 digits get the 91 prefix; anything else is sent as digits. */
export function waNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, "");
}

export const waLink = (phone: string, text: string) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

export interface WaSendResult {
  /** "sent" = delivered to the provider's API; "link" = staff must open waLink on a device */
  method: "sent" | "link";
  provider: WaProvider;
  waLink: string;
  messageId?: string;
  /** Why the API send didn't happen (shown to staff; never contains secrets) */
  error?: string;
}

export interface WaMessage {
  to: string;
  /** Plain text for the click-to-chat fallback (and logs) */
  text: string;
  purpose: WaPurpose;
  /** Template parameters in template order (Meta uses the order, WATI the names) */
  params: { name: string; value: string }[];
  /** WATI broadcast name (groups messages in WATI's dashboard) */
  tag?: string;
}

/** Meta Cloud API request body for a template message (exported for tests). */
export function metaTemplateBody(to: string, template: string, language: string, params: { value: string }[]) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: language },
      ...(params.length && { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p.value || "-" })) }] }),
    },
  };
}

const TIMEOUT_MS = 10_000;

export async function sendWhatsApp(msg: WaMessage, cfg?: WaConfig): Promise<WaSendResult> {
  const config = cfg ?? (await getWaConfig());
  const link = waLink(msg.to, msg.text);
  const to = waNumber(msg.to);
  const template = config.templates[msg.purpose];
  // Providers sometimes echo the token in error messages (Meta: "Malformed access token …"):
  // strip secrets before the reason reaches logs, API responses or the audit log (BUG-005).
  const secrets = [config.meta?.accessToken, config.wati?.token].filter((t): t is string => Boolean(t && t.length >= 6));
  const redact = (text: string) => secrets.reduce((t, sec) => t.split(sec).join("[redacted]"), text);
  const fail = (raw: string): WaSendResult => {
    const error = redact(raw);
    console.warn(`[whatsapp] ${config.provider} send failed for ${msg.purpose}: ${error}; using click-to-chat link`);
    return { method: "link", provider: config.provider, waLink: link, error };
  };
  try {
    if (config.provider === "META") {
      if (!config.meta?.phoneNumberId || !config.meta.accessToken) return fail("Meta phone number id or access token missing");
      const url = `${(config.meta.baseUrl ?? env.WHATSAPP_META_BASE_URL).replace(/\/$/, "")}/${env.WHATSAPP_META_GRAPH_VERSION}/${encodeURIComponent(config.meta.phoneNumberId)}/messages`;
      // The default test template (hello_world) takes no parameters.
      const params = msg.purpose === "test" && template === "hello_world" ? [] : msg.params;
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.meta.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(metaTemplateBody(to, template, config.templateLanguages?.[msg.purpose] || config.meta.language, params)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
      if (!res.ok) return fail(`Meta API ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}`);
      return { method: "sent", provider: "META", waLink: link, messageId: body.messages?.[0]?.id };
    }
    if (config.provider === "WATI") {
      if (!config.wati?.apiUrl || !config.wati.token) return fail("WATI API URL or token missing");
      const res = await fetch(`${config.wati.apiUrl}/api/v1/sendTemplateMessage?whatsappNumber=${to}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.wati.token}`, "content-type": "application/json" },
        body: JSON.stringify({ template_name: template, broadcast_name: msg.tag ?? `${msg.purpose}_${Date.now()}`, parameters: msg.params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: boolean; info?: string; message?: string };
      // WATI answers 200 with result:false when the template or number is rejected.
      if (!res.ok || body.result === false) return fail(`WATI ${res.status}${body.info || body.message ? `: ${body.info ?? body.message}` : ""}`);
      return { method: "sent", provider: "WATI", waLink: link };
    }
  } catch (e) {
    return fail(e instanceof Error ? (e.name === "TimeoutError" ? "provider did not answer in 10 s" : e.message) : "unknown error");
  }
  return { method: "link", provider: "NONE", waLink: link };
}

// ---------------------------------------------------------------------------
// Purpose-specific helpers
// ---------------------------------------------------------------------------

/** Kept for callers: "sent" via the business's provider, else a wa.me link. */
export type ShareResult = WaSendResult;

export async function shareReceipt(opts: { phone: string; outletName: string; invoiceNumber: string; amountText: string; receiptUrl: string }): Promise<ShareResult> {
  const text = `Thank you for visiting ${opts.outletName}!\nBill ${opts.invoiceNumber} — ${opts.amountText}\nDownload your receipt: ${opts.receiptUrl}`;
  return sendWhatsApp({
    to: opts.phone,
    text,
    purpose: "receipt",
    tag: `receipt_${opts.invoiceNumber}`,
    params: [
      { name: "outlet", value: opts.outletName },
      { name: "invoice", value: opts.invoiceNumber },
      { name: "amount", value: opts.amountText },
      { name: "link", value: opts.receiptUrl },
    ],
  });
}
