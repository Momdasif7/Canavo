import { env } from "../env";
import { dataKey, decryptWith, encryptWith } from "../lib/crypto";
import { currentBusinessId } from "../lib/tenant";
import { loadIntegration, type LoadedIntegration } from "./integrations";

/**
 * WhatsApp messaging for a business.
 *
 * Each business picks a provider in Settings → Integrations → WhatsApp:
 *  - META: the official WhatsApp Cloud API (phone number id + access token),
 *  - WATI: a WATI account (API URL + token),
 *  - NONE: no API; every message is a wa.me click-to-chat link staff open.
 * Business-initiated messages must use templates approved in the provider's console (Meta WhatsApp
 * Manager / WATI); the template name + language per message type are set per business in Settings →
 * WhatsApp templates. Any API failure falls back to the click-to-chat link, so sending never blocks.
 * Stored in BusinessIntegration (kind WHATSAPP); tokens encrypted (AES-256-GCM, DATA_ENCRYPTION_KEY).
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

/**
 * What CANAVO sends for each message type: the body variables in order ({{1}}, {{2}}, …) with sample
 * values, and a suggested template text to submit in Meta WhatsApp Manager. Keep `variables` in sync
 * with the callers (shareReceipt, customers.ts khata reminder, jobs-crm.ts wishes, delivery.ts, notify.ts).
 */
export const WA_TEMPLATE_CATALOG: Record<WaPurpose, { label: string; description: string; category: "UTILITY" | "MARKETING"; variables: { name: string; sample: string }[]; suggestedBody: string }> = {
  receipt: {
    label: "Receipt",
    description: "Bill shared from Bills / POS",
    category: "UTILITY",
    variables: [
      { name: "outlet", sample: "Spice Garden" },
      { name: "invoice", sample: "INV-1042" },
      { name: "amount", sample: "₹450.00" },
      { name: "link", sample: "https://api.example.in/public/receipts/abc123" },
    ],
    suggestedBody: "Thank you for visiting {{1}}! Your bill {{2}} for {{3}} is ready. Download your receipt: {{4}}",
  },
  khata_reminder: {
    label: "Khata reminder",
    description: "Credit balance reminder to a customer",
    category: "UTILITY",
    variables: [
      { name: "name", sample: "Priya" },
      { name: "outlet", sample: "Spice Garden" },
      { name: "amount", sample: "₹1,250.00" },
    ],
    suggestedBody: "Hi {{1}}, this is a friendly reminder from {{2}}: your credit (khata) balance is {{3}}. Please clear it on your next visit. Thank you!",
  },
  birthday: {
    label: "Birthday",
    description: "Birthday wish with a coupon",
    category: "MARKETING",
    variables: [
      { name: "name", sample: "Priya" },
      { name: "outlet", sample: "Spice Garden" },
      { name: "coupon code", sample: "BDAY-7F3K" },
    ],
    suggestedBody: "Happy birthday {{1}}! {{2}} wishes you a wonderful year. Show code {{3}} on your next visit for a birthday treat.",
  },
  anniversary: {
    label: "Anniversary",
    description: "Anniversary wish with a coupon",
    category: "MARKETING",
    variables: [
      { name: "name", sample: "Priya" },
      { name: "outlet", sample: "Spice Garden" },
      { name: "coupon code", sample: "ANNI-9Q2M" },
    ],
    suggestedBody: "Happy anniversary {{1}}! Celebrate with {{2}} — show code {{3}} on your next visit for a special treat.",
  },
  delivery_update: {
    label: "Delivery update",
    description: "Delivery status sent to the customer",
    category: "UTILITY",
    variables: [
      { name: "outlet", sample: "Spice Garden" },
      { name: "invoice", sample: "INV-1042" },
      { name: "status message", sample: "Your order is out for delivery with Ravi, arriving by 8:15 PM" },
    ],
    suggestedBody: "{{1}}: update on your order {{2}} — {{3}}",
  },
  staff_alert: {
    label: "Staff alert",
    description: "Alerts to staff who turned WhatsApp on",
    category: "UTILITY",
    variables: [
      { name: "title", sample: "Low stock" },
      { name: "body", sample: "Paneer is below 2 kg at Main outlet" },
    ],
    suggestedBody: "CANAVO alert: {{1}} — {{2}}",
  },
  test: {
    label: "Test",
    description: "The connection test (Meta's hello_world takes no variables)",
    category: "UTILITY",
    variables: [{ name: "message", sample: "WhatsApp is connected" }],
    suggestedBody: "Test message from CANAVO: {{1}}",
  },
};

/** Fill {{1}}, {{2}}… with values (missing ones stay visible). */
export const renderTemplate = (body: string, values: string[]) => body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => values[Number(n) - 1] ?? m);

/** Per message type: the approved template's name, language and (for the preview only) its text. */
export interface WaTemplateSetting {
  name?: string;
  language?: string;
  body?: string;
}

/** Non-secret WhatsApp settings (BusinessIntegration.config, kind WHATSAPP). Tokens are in `secrets`. */
export interface StoredWaConfig {
  provider: WaProvider;
  meta?: { phoneNumberId: string; language?: string };
  wati?: { apiUrl: string };
  /** Older setups stored just the template name per purpose */
  templates?: Partial<Record<WaPurpose, string | WaTemplateSetting>>;
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
  /** Template language per purpose (defaults to meta.language) */
  languages?: Partial<Record<WaPurpose, string>>;
  autoDeliveryUpdates: boolean;
  staffAlerts: boolean;
  /** Config comes from server env (WATI_*) because the business has none */
  fromEnv: boolean;
}

export const encryptSecret = (plain: string) => encryptWith(dataKey(), plain);
export const decryptSecret = (enc?: string) => {
  if (!enc) return "";
  try {
    return decryptWith(dataKey(), enc);
  } catch {
    return "";
  }
};

/** Template settings per purpose, normalised (old setups stored a bare name). */
export function templateSettings(stored: StoredWaConfig | null): Record<WaPurpose, WaTemplateSetting> {
  return Object.fromEntries(
    WA_PURPOSES.map((p) => {
      const t = stored?.templates?.[p];
      return [p, typeof t === "string" ? { name: t } : t && typeof t === "object" ? { name: t.name, language: t.language, body: t.body } : {}];
    }),
  ) as Record<WaPurpose, WaTemplateSetting>;
}

export async function getWaIntegration(businessId: string): Promise<{ stored: StoredWaConfig | null; row: LoadedIntegration | null }> {
  const row = await loadIntegration("WHATSAPP", businessId);
  return { row, stored: row ? (row.config as unknown as StoredWaConfig) : null };
}

/** Kept for callers: the stored non-secret settings. */
export async function getStoredConfig(businessId: string): Promise<StoredWaConfig | null> {
  return (await getWaIntegration(businessId)).stored;
}

export async function getWaConfig(businessId = currentBusinessId()): Promise<WaConfig> {
  const { stored, row } = businessId ? await getWaIntegration(businessId) : { stored: null, row: null };
  const settings = templateSettings(stored);
  const templates = Object.fromEntries(WA_PURPOSES.map((p) => [p, settings[p].name || DEFAULT_TEMPLATES[p]])) as Record<WaPurpose, string>;
  const languages = Object.fromEntries(WA_PURPOSES.filter((p) => settings[p].language).map((p) => [p, settings[p].language!])) as Partial<Record<WaPurpose, string>>;
  if (stored && row && row.enabled && stored.provider !== "NONE") {
    return {
      provider: stored.provider,
      meta: stored.meta ? { phoneNumberId: stored.meta.phoneNumberId, accessToken: row.secret("metaAccessToken"), language: stored.meta.language || "en" } : undefined,
      wati: stored.wati ? { apiUrl: stored.wati.apiUrl.replace(/\/$/, ""), token: row.secret("watiToken") } : undefined,
      templates,
      languages,
      autoDeliveryUpdates: stored.autoDeliveryUpdates ?? false,
      staffAlerts: stored.staffAlerts ?? false,
      fromEnv: false,
    };
  }
  if (!stored && env.WATI_API_URL && env.WATI_API_TOKEN) {
    return { provider: "WATI", wati: { apiUrl: env.WATI_API_URL.replace(/\/$/, ""), token: env.WATI_API_TOKEN }, templates, languages, autoDeliveryUpdates: false, staffAlerts: false, fromEnv: true };
  }
  return { provider: "NONE", templates, languages, autoDeliveryUpdates: stored?.autoDeliveryUpdates ?? false, staffAlerts: stored?.staffAlerts ?? false, fromEnv: false };
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
        body: JSON.stringify(metaTemplateBody(to, template, config.languages?.[msg.purpose] || config.meta.language, params)),
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

/**
 * "Test connection" without sending a message: Meta — read the phone number with the token;
 * WATI — list one contact. Never throws; the message never contains the token.
 */
export async function checkWhatsAppCredentials(config: WaConfig): Promise<{ ok: boolean; message: string }> {
  const secrets = [config.meta?.accessToken, config.wati?.token].filter((t): t is string => Boolean(t && t.length >= 4));
  const redact = (text: string) => secrets.reduce((t, sec) => t.split(sec).join("[redacted]"), text).slice(0, 200);
  try {
    if (config.provider === "META" && config.meta?.accessToken) {
      const url = `${(config.meta.baseUrl ?? env.WHATSAPP_META_BASE_URL).replace(/\/$/, "")}/${env.WHATSAPP_META_GRAPH_VERSION}/${encodeURIComponent(config.meta.phoneNumberId)}?fields=display_phone_number,verified_name`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${config.meta.accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string; error?: { message?: string } };
      if (!res.ok) return { ok: false, message: redact(`Meta API ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}`) };
      return { ok: true, message: redact(`Meta accepted the token${body.display_phone_number ? ` for ${body.display_phone_number}${body.verified_name ? ` (${body.verified_name})` : ""}` : ""}`) };
    }
    if (config.provider === "WATI" && config.wati?.token) {
      const res = await fetch(`${config.wati.apiUrl}/api/v1/getContacts?pageSize=1`, { headers: { authorization: `Bearer ${config.wati.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return { ok: false, message: `WATI answered ${res.status}` };
      return { ok: true, message: "WATI accepted the token" };
    }
    return { ok: false, message: "No WhatsApp API is set up (messages open as click-to-chat links)" };
  } catch (e) {
    return { ok: false, message: redact(e instanceof Error ? (e.name === "TimeoutError" ? "provider did not answer in 10 s" : e.message) : "unknown error") };
  }
}
