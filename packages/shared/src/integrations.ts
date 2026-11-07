import { z } from "zod";

/**
 * Store integrations (Settings → Integrations): each business connects its own Razorpay,
 * email (SMTP) and SMS (MSG91) accounts. Secrets are write-only: the API stores them
 * encrypted and only ever returns a masked hint. A blank secret on save keeps the saved one.
 */

/** "" (a field the owner left blank) means "not given". */
const blank = <T extends z.ZodTypeAny>(inner: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), inner.optional());

export const razorpayIntegrationSchema = z
  .object({
    keyId: blank(z.string().trim().regex(/^rzp_(live|test)_[A-Za-z0-9]{6,40}$/, "Key ID starts with rzp_live_ or rzp_test_")),
    keySecret: blank(z.string().trim().regex(/^[A-Za-z0-9]{10,128}$/, "Key secret is letters and digits only")),
    webhookSecret: blank(z.string().trim().min(8, "Webhook secret needs at least 8 characters").max(256).regex(/^\S+$/, "Webhook secret can't contain spaces")),
  })
  .strict();
export type RazorpayIntegrationInput = z.infer<typeof razorpayIntegrationSchema>;

/** Ports a mail provider uses for submission. Anything else is refused (no port scanning through the test button). */
export const SMTP_PORTS = [25, 465, 587, 2525] as const;
const hostname = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const fromAddress = /^(?:[^<>@\r\n]{1,100} <)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/;

export const smtpIntegrationSchema = z
  .object({
    host: z.string().trim().toLowerCase().regex(hostname, "Enter the mail server name, e.g. smtp.gmail.com"),
    port: z.number().int().refine((p) => (SMTP_PORTS as readonly number[]).includes(p), `Port must be one of ${SMTP_PORTS.join(", ")}`),
    /** TLS from the start (port 465). Off = STARTTLS on 587 / 25 / 2525. */
    secure: z.boolean().optional(),
    user: blank(z.string().trim().max(254)),
    /** Omit (or leave blank) to keep the saved password */
    password: blank(z.string().max(1024)),
    from: z
      .string()
      .trim()
      .max(254)
      .refine((s) => fromAddress.test(s) && (!s.includes("<") || s.endsWith(">")), "From address: you@hotel.in or Hotel Name <you@hotel.in>"),
  })
  .strict();
export type SmtpIntegrationInput = z.infer<typeof smtpIntegrationSchema>;

const msg91Template = blank(z.string().trim().regex(/^[A-Za-z0-9]{6,40}$/, "Template ID is letters and digits from MSG91"));
export const smsIntegrationSchema = z
  .object({
    authKey: blank(z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "Auth key is letters and digits from MSG91 → API")),
    otpTemplateId: msg91Template,
    alertTemplateId: msg91Template,
  })
  .strict();
export type SmsIntegrationInput = z.infer<typeof smsIntegrationSchema>;

/** Test-send to a number the owner types (SMS test, WhatsApp template test). */
export const integrationTestPhoneSchema = z.object({ phone: z.string().trim().regex(/^(\+?91)?[6-9]\d{9}$/, "Enter a 10-digit Indian mobile number") }).strict();

// ---------------------------------------------------------------------------
// WhatsApp templates: what each message purpose fills in, and a local preview.
// The wording itself lives in Meta WhatsApp Manager / WATI (Meta must approve it).
// ---------------------------------------------------------------------------

export const WA_TEMPLATE_PURPOSES = ["receipt", "khata_reminder", "birthday", "anniversary", "delivery_update", "staff_alert", "test"] as const;
export type WaTemplatePurpose = (typeof WA_TEMPLATE_PURPOSES)[number];

export interface WaTemplateVariable {
  /** Parameter name sent to WATI; Meta uses the position ({{1}}, {{2}} …) */
  name: string;
  label: string;
  sample: string;
}

export interface WaTemplateInfo {
  label: string;
  description: string;
  /** Meta template category to pick when creating it */
  category: "UTILITY" | "MARKETING";
  variables: WaTemplateVariable[];
  /** Suggested body text to submit to Meta, with {{n}} placeholders in variable order */
  sampleText: string;
}

export const WA_TEMPLATE_CATALOG: Record<WaTemplatePurpose, WaTemplateInfo> = {
  receipt: {
    label: "Receipt",
    description: "Bill shared from Bills / POS",
    category: "UTILITY",
    variables: [
      { name: "outlet", label: "Outlet name", sample: "Hotel Saravana" },
      { name: "invoice", label: "Bill number", sample: "INV-2026-0142" },
      { name: "amount", label: "Bill amount", sample: "₹482.00" },
      { name: "link", label: "Receipt link", sample: "https://canavo.in/r/abc123" },
    ],
    sampleText: "Thank you for visiting {{1}}!\nBill {{2}} for {{3}}.\nDownload your receipt: {{4}}",
  },
  khata_reminder: {
    label: "Khata reminder",
    description: "Credit balance reminder to a customer",
    category: "UTILITY",
    variables: [
      { name: "name", label: "Customer name", sample: "Ravi" },
      { name: "outlet", label: "Outlet name", sample: "Hotel Saravana" },
      { name: "amount", label: "Amount due", sample: "₹1,250.00" },
    ],
    sampleText: "Hello {{1}}, this is a friendly reminder from {{2}}. Your khata balance is {{3}}. Please clear it on your next visit. Thank you!",
  },
  birthday: {
    label: "Birthday",
    description: "Birthday wish with a coupon",
    category: "MARKETING",
    variables: [
      { name: "name", label: "Customer name", sample: "Priya" },
      { name: "outlet", label: "Outlet name", sample: "Hotel Saravana" },
      { name: "code", label: "Coupon code", sample: "BDAY7K2Q" },
    ],
    sampleText: "Happy Birthday, {{1}}! Warm wishes from {{2}}. Enjoy a treat on your next visit with code {{3}} (valid 7 days).",
  },
  anniversary: {
    label: "Anniversary",
    description: "Anniversary wish with a coupon",
    category: "MARKETING",
    variables: [
      { name: "name", label: "Customer name", sample: "Priya" },
      { name: "outlet", label: "Outlet name", sample: "Hotel Saravana" },
      { name: "code", label: "Coupon code", sample: "ANNV3M8P" },
    ],
    sampleText: "Happy Anniversary, {{1}}! Warm wishes from {{2}}. Celebrate with us using code {{3}} (valid 7 days).",
  },
  delivery_update: {
    label: "Delivery update",
    description: "Delivery status sent to the customer",
    category: "UTILITY",
    variables: [
      { name: "outlet", label: "Outlet name", sample: "Hotel Saravana" },
      { name: "invoice", label: "Bill number", sample: "INV-2026-0142" },
      { name: "status", label: "Status message", sample: "Your order is out for delivery. Arriving by 8:15 PM." },
    ],
    sampleText: "{{1}}: update on order {{2}}.\n{{3}}",
  },
  staff_alert: {
    label: "Staff alert",
    description: "Alerts to staff who turned WhatsApp on",
    category: "UTILITY",
    variables: [
      { name: "title", label: "Alert title", sample: "Low stock" },
      { name: "body", label: "Alert details", sample: "Paneer is below 2 kg at Main outlet." },
    ],
    sampleText: "CANAVO alert: {{1}}\n{{2}}",
  },
  test: {
    label: "Test",
    description: "The test message on this page",
    category: "UTILITY",
    variables: [],
    sampleText:
      "Hello World\n\nWelcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta. Thank you for taking the time to test with us.",
  },
};

/** Fill {{1}}, {{2}} … with values in order; a missing value stays as the placeholder. */
export function renderWaPreview(text: string, values: readonly string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => values[Number(n) - 1] ?? m);
}

/** Preview of a purpose's suggested text with its sample values. */
export const waSamplePreview = (purpose: WaTemplatePurpose) =>
  renderWaPreview(WA_TEMPLATE_CATALOG[purpose].sampleText, WA_TEMPLATE_CATALOG[purpose].variables.map((v) => v.sample));

/** Meta template language code, e.g. en, en_US, hi, ta. */
export const waLanguageCode = z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Language code, e.g. en, en_US, hi or ta");

/** Masked hint for a saved secret: "rzp_live_••••4f2a", "••••4f2a"; short values show only dots. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length < 8) return "••••";
  const prefix = value.match(/^(rzp_(?:live|test)_)/)?.[1] ?? "";
  return `${prefix}••••${value.slice(-4)}`;
}
