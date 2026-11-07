/**
 * Store integrations (Settings → Integrations): each store's own Razorpay, email (SMTP), SMS
 * (MSG91) and WhatsApp. Privacy & security checklist, one block each:
 *  1. secrets encrypted at rest, never returned (masked hints), blank keeps the saved secret
 *  2. owner only (managers, cashiers … 403), every change audited without secrets
 *  3. super admin, support views, owner export and backups never expose them
 *  4. no keys in logs or error bodies (providers that echo the key)
 *  5. one store's keys never used for another (QR, per-store webhook)
 *  6. test buttons: owner only, rate-limited, no probing of internal hosts (SSRF)
 * plus the no-payment-fallback rule, email / SMS fallback to the platform account, and the
 * WhatsApp template page (per-purpose language, test send with sample values).
 * Every provider is mocked: fetch for Razorpay / MSG91 / Meta, the nodemailer transport for SMTP.
 */
import crypto from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/env";
import { logger } from "../../src/lib/observability";
import { currentStep, totpAt } from "../../src/lib/totp";
import { runForBusiness } from "../../src/lib/tenant";
import { backupsDir, createBackup } from "../../src/services/backup";
import { smtpConnectTarget } from "../../src/services/integrations";
import { sendMail } from "../../src/services/mailer";
import { sendOtpSms, sendSms } from "../../src/services/sms";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { allowedRoles, cast, createPlatformAdmin, db, expectAuthz, expectNoSecrets, HUGE, signIn, type Cast, type Session } from "./kit-auth";

// ---------------------------------------------------------------------------
// Mocked providers
// ---------------------------------------------------------------------------

const smtp = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  verify: { error: null as (Error & { code?: string; responseCode?: number }) | null },
  sent: [] as Record<string, unknown>[],
}));
vi.mock("nodemailer", () => {
  const createTransport = (opts: Record<string, unknown>) => {
    smtp.created.push(opts);
    return {
      verify: async () => {
        if (smtp.verify.error) throw smtp.verify.error;
        return true;
      },
      sendMail: async (m: Record<string, unknown>) => {
        smtp.sent.push({ ...m, transport: opts });
        return { messageId: `<m${smtp.sent.length}@test>` };
      },
      close: () => undefined,
    };
  };
  return { default: { createTransport }, createTransport };
});

const RZP = "https://rzp.mock.test";
const META = "https://graph.mock.test";
type Call = { url: string; method: string; headers: Record<string, string>; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: Call[] = [];
/** Override the next provider answer per URL prefix (e.g. a failure that echoes the key). */
const replies = new Map<string, (c: Call) => Response>();
const realFetch = globalThis.fetch;
let qrSeq = 0;

function providerReply(c: Call): Response {
  for (const [prefix, fn] of replies) if (c.url.startsWith(prefix)) return fn(c);
  const json = (b: object, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (c.url.startsWith(`${RZP}/v1/payments/qr_codes`)) return json({ id: `qr_T${++qrSeq}${Date.now()}`, image_url: "https://rzp.mock.test/qr.png" });
  if (c.url.startsWith(`${RZP}/v1/payments?count=1`)) return json({ entity: "collection", count: 0, items: [] });
  if (c.url.startsWith("https://control.msg91.com/")) return json({ type: "success", message: "ok" });
  if (c.url.startsWith(META)) return json({ messages: [{ id: "wamid.T1" }] });
  return json({ error: "not mocked" }, 404);
}

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(RZP) && !url.startsWith(META) && !url.startsWith("https://control.msg91.com")) return realFetch(input, init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    } catch {
      /* raw */
    }
    const c = { url, method: init?.method ?? "GET", headers, body };
    calls.push(c);
    return providerReply(c);
  });
});

/** Everything printed while a block runs (console and the structured logger). */
const printed: string[] = [];
beforeEach(() => {
  printed.length = 0;
  const grab = (...a: unknown[]) => void printed.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (v instanceof Error ? v.message : v)))).join(" "));
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab);
  for (const m of ["info", "warn", "error", "debug", "fatal"] as const) vi.spyOn(logger, m).mockImplementation(grab as never);
});
afterEach(() => {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) (console[m] as unknown as { mockRestore?: () => void }).mockRestore?.();
  for (const m of ["info", "warn", "error", "debug", "fatal"] as const) (logger[m] as unknown as { mockRestore?: () => void }).mockRestore?.();
});

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

let srv: Awaited<ReturnType<typeof startServer>>;
let a: Hotel, b: Hotel;
let c: Cast;
let ownerA: Session, ownerB: Session, managerA: Session, cashierA: Session, admin: Session;
const saved = { base: env.RAZORPAY_BASE_URL, meta: env.WHATSAPP_META_BASE_URL, mock: env.PAYMENTS_DEV_MOCK, smtpHost: env.SMTP_HOST, smtpFrom: env.SMTP_FROM, msgKey: env.MSG91_AUTH_KEY, msgOtp: env.MSG91_TEMPLATE_ID, msgAlert: env.MSG91_ALERT_TEMPLATE_ID, hook: env.RAZORPAY_WEBHOOK_SECRET };

// Two stores, two Razorpay accounts.
const KEYS = {
  a: { keyId: "rzp_test_AAAAaaaa1111", keySecret: "AsecretAAAAAAAAAAAAAAAA1", webhookSecret: "whsec-store-A-123456" },
  b: { keyId: "rzp_live_BBBBbbbb2222", keySecret: "BsecretBBBBBBBBBBBBBBBB2", webhookSecret: "whsec-store-B-654321" },
};
const SMTP_PASS = "smtp-Pa55word-SECRET-xyz";
const MSG91_KEY = "msg91AuthKeySECRET0123456789";
const META_TOKEN = "EAAG-meta-SECRET-token-0123456789ABCD";
const ALL_SECRETS = [KEYS.a.keySecret, KEYS.a.webhookSecret, KEYS.b.keySecret, KEYS.b.webhookSecret, SMTP_PASS, MSG91_KEY, META_TOKEN];

beforeAll(async () => {
  Object.assign(env, { RAZORPAY_BASE_URL: RZP, WHATSAPP_META_BASE_URL: META });
  srv = await startServer();
  [a, b] = [await createHotel("Integrations A"), await createHotel("Integrations B")];
  c = await cast(srv.base, a);
  ({ BUSINESS_OWNER: ownerA, OUTLET_MANAGER: managerA, CASHIER: cashierA } = c.clients);
  ownerB = await signIn(srv.base, b.users.owner.email, b.outletId);
  admin = await signIn(srv.base, (await createPlatformAdmin()).email);
});
afterAll(async () => {
  Object.assign(env, {
    RAZORPAY_BASE_URL: saved.base,
    WHATSAPP_META_BASE_URL: saved.meta,
    PAYMENTS_DEV_MOCK: saved.mock,
    SMTP_HOST: saved.smtpHost,
    SMTP_FROM: saved.smtpFrom,
    MSG91_AUTH_KEY: saved.msgKey,
    MSG91_TEMPLATE_ID: saved.msgOtp,
    MSG91_ALERT_TEMPLATE_ID: saved.msgAlert,
    RAZORPAY_WEBHOOK_SECRET: saved.hook,
  });
  vi.restoreAllMocks();
  await srv.close();
});

const basicOf = (k: { keyId: string; keySecret: string }) => `Basic ${Buffer.from(`${k.keyId}:${k.keySecret}`).toString("base64")}`;
const sign = (raw: string, secret: string) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const hook = (url: string, raw: string, sig: string) =>
  realFetch(`${srv.base}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const settingValue = async (h: Hotel, key: string) => JSON.stringify((await db.setting.findUnique({ where: { scope_key: { scope: h.businessId, key } } }))?.value ?? null);
const auditsOf = async (h: Hotel, prefix: string) => db.auditLog.findMany({ where: { businessId: h.businessId, action: { startsWith: prefix } }, orderBy: { createdAt: "asc" } });
async function openOrder(s: Session, h: Hotel) {
  const r = await s.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; grandTotal: number };
}

// ---------------------------------------------------------------------------

describe("2. owner only", () => {
  const owner = allowedRoles(["outlet:manage"], "PUT");
  it.each([
    ["GET", "/admin/integrations", undefined],
    ["PUT", "/admin/integrations/razorpay", {}],
    ["DELETE", "/admin/integrations/razorpay", undefined],
    ["POST", "/admin/integrations/razorpay/test", {}],
    ["PUT", "/admin/integrations/smtp", {}],
    ["DELETE", "/admin/integrations/smtp", undefined],
    ["POST", "/admin/integrations/smtp/test", {}],
    ["PUT", "/admin/integrations/sms", {}],
    ["DELETE", "/admin/integrations/sms", undefined],
    ["POST", "/admin/integrations/sms/test", {}],
    ["GET", "/admin/whatsapp", undefined],
    ["PUT", "/admin/whatsapp", {}],
    ["POST", "/admin/whatsapp/test", {}],
    ["POST", "/admin/whatsapp/templates/receipt/test", {}],
  ] as const)("%s %s → only the owner", async (method, p, body) => {
    expect(owner).toEqual(["BUSINESS_OWNER"]);
    // GET is read-only, but managers / auditors still don't see integrations (default owner-only).
    await expectAuthz(c, method, p, owner, body);
  });

  it("the platform admin can't open a store's integrations", async () => {
    for (const p of ["/admin/integrations", "/admin/whatsapp"]) {
      expect((await admin.call("GET", p)).status, p).toBe(403);
      expect((await admin.call("GET", p, undefined, { "x-outlet-id": a.outletId, "x-business-id": a.businessId })).status, p).toBe(403);
    }
    expect((await admin.call("PUT", "/admin/integrations/razorpay", KEYS.a)).status).toBe(403);
  });

  it("every change is audited, without secret values", async () => {
    expect((await ownerA.call("PUT", "/admin/integrations/razorpay", KEYS.a)).status).toBe(200);
    expect((await ownerA.call("PUT", "/admin/integrations/smtp", { host: "203.0.113.25", port: 587, user: "billing@hotel.in", password: SMTP_PASS, from: "Hotel A <billing@hotel.in>" })).status).toBe(200);
    expect((await ownerA.call("PUT", "/admin/integrations/sms", { authKey: MSG91_KEY, otpTemplateId: "otpTPL123456", alertTemplateId: "alertTPL123456" })).status).toBe(200);
    expect((await ownerA.call("PUT", "/admin/whatsapp", { provider: "META", meta: { phoneNumberId: "1234567890", accessToken: META_TOKEN } })).status).toBe(200);
    const rows = [...(await auditsOf(a, "integration.")), ...(await auditsOf(a, "whatsapp."))];
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["integration.razorpay.update", "integration.smtp.update", "integration.sms.update", "whatsapp.config"]));
    expect(rows.find((r) => r.action === "integration.razorpay.update")?.meta).toMatchObject({ changed: ["keyId", "keySecret", "webhookSecret"], mode: "test" });
    expect(rows.every((r) => r.userId === c.ids.BUSINESS_OWNER)).toBe(true);
    const text = JSON.stringify(rows);
    for (const s of [...ALL_SECRETS, KEYS.a.keyId]) expect(text, s).not.toContain(s);
  });
});

describe("1. encrypted at rest, masked, blank keeps the saved secret", () => {
  it("the DB value holds no plaintext; GET returns masked hints only", async () => {
    const stored = await settingValue(a, "integrations.razorpay");
    for (const s of [KEYS.a.keyId, KEYS.a.keySecret, KEYS.a.webhookSecret]) expect(stored).not.toContain(s);
    expect(stored).toMatch(/"keySecretEnc":"v1:/);
    expect(await settingValue(a, "integrations.smtp")).not.toContain(SMTP_PASS);
    expect(await settingValue(a, "integrations.sms")).not.toContain(MSG91_KEY);
    expect(await settingValue(a, "whatsapp.config")).not.toContain(META_TOKEN);

    const r = await ownerA.call("GET", "/admin/integrations");
    expect(r.status).toBe(200);
    expect(r.body.razorpay).toMatchObject({ connected: true, keyId: "rzp_test_••••1111", keySecret: "••••AAA1", webhookSecret: "••••3456", mode: "test", platformFallback: false });
    expect(r.body.razorpay.webhookUrl).toMatch(/\/webhooks\/razorpay\/[A-Za-z0-9_-]{24}$/);
    expect(r.body.smtp).toMatchObject({ connected: true, host: "203.0.113.25", port: 587, secure: false, user: "billing@hotel.in", password: "••••-xyz", from: "Hotel A <billing@hotel.in>" });
    expect(r.body.sms).toMatchObject({ connected: true, authKey: "••••6789", otpTemplateId: "otpTPL123456", using: { otp: "store", alert: "store" } });
    expect(r.body.whatsapp).toMatchObject({ provider: "META", connected: true });
    const text = JSON.stringify(r.body);
    for (const s of [...ALL_SECRETS, KEYS.a.keyId]) expect(text, s).not.toContain(s);
    expect(text).not.toMatch(/Enc"|v1:/);
    expectNoSecrets(r.body);
  });

  it("leaving secrets blank keeps them; a new key ID needs its secret", async () => {
    const before = await settingValue(a, "integrations.razorpay");
    const r = await ownerA.call("PUT", "/admin/integrations/razorpay", { keyId: "", keySecret: "", webhookSecret: "" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ keyId: "rzp_test_••••1111", keySecret: "••••AAA1", webhookSecret: "••••3456" });
    expect(JSON.parse(await settingValue(a, "integrations.razorpay")).keySecretEnc).toBe(JSON.parse(before).keySecretEnc);
    expect((await ownerA.call("PUT", "/admin/integrations/razorpay", { keyId: "rzp_test_OTHERkey9999" })).status).toBe(400);
    // SMTP: blank password keeps it
    const s = await ownerA.call("PUT", "/admin/integrations/smtp", { host: "203.0.113.25", port: 587, user: "billing@hotel.in", password: "", from: "billing@hotel.in" });
    expect(s.status).toBe(200);
    expect(s.body.password).toBe("••••-xyz");
    // SMS: blank auth key keeps it
    expect((await ownerA.call("PUT", "/admin/integrations/sms", { authKey: "", otpTemplateId: "otpTPL123456", alertTemplateId: "alertTPL123456" })).body.authKey).toBe("••••6789");
  });

  it("bad input → 400 (never 500), nothing saved", async () => {
    const before = await settingValue(a, "integrations.razorpay");
    for (const body of [
      { keyId: "pk_live_123" },
      { keyId: "rzp_test_AAAAaaaa1111", keySecret: "has spaces in it!!" },
      { keyId: 12345 },
      { webhookSecret: "short" },
      { keyId: "rzp_test_AAAAaaaa1111", keySecret: HUGE },
      { ...KEYS.a, businessId: b.businessId },
      [],
      "rzp",
    ])
      expect((await ownerA.call("PUT", "/admin/integrations/razorpay", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect(await settingValue(a, "integrations.razorpay")).toBe(before);
    for (const body of [
      {},
      { host: "smtp.gmail.com", port: "587", from: "a@b.in" },
      { host: "smtp.gmail.com", port: 22, from: "a@b.in" },
      { host: "smtp.gmail.com", port: 587, from: "not an email" },
      { host: "smtp gmail com", port: 587, from: "a@b.in" },
      { host: "smtp.gmail.com", port: 587, from: "a@b.in", secure: "yes" },
      { host: HUGE, port: 587, from: "a@b.in" },
    ])
      expect((await ownerA.call("PUT", "/admin/integrations/smtp", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    for (const body of [{ authKey: "short", otpTemplateId: "abcdef12" }, { otpTemplateId: "x" }, { authKey: MSG91_KEY }, { authKey: MSG91_KEY, alertTemplateId: "has space 123" }])
      expect((await ownerB.call("PUT", "/admin/integrations/sms", body)).status, JSON.stringify(body)).toBe(400);
    // Nothing saved for B, and a store without keys can't "keep" what it doesn't have
    expect((await ownerB.call("PUT", "/admin/integrations/razorpay", {})).status).toBe(400);
    expect((await ownerB.call("POST", "/admin/integrations/razorpay/test", {})).status).toBe(400);
    expect((await ownerB.call("POST", "/admin/integrations/sms/test", { phone: "9876543210" })).status).toBe(400);
    expect((await ownerA.call("POST", "/admin/integrations/sms/test", { phone: "12345" })).status).toBe(400);
  });

  it("generic /admin/settings can't read or write integration rows", async () => {
    for (const key of ["integrations.razorpay", "whatsapp.config", "integrations.smtp"]) {
      expect((await ownerA.call("GET", `/admin/settings/GLOBAL/${key}`)).status, key).toBe(400);
      expect((await ownerA.call("PUT", `/admin/settings/GLOBAL/${key}`, { value: {} })).status, key).toBe(400);
    }
  });
});

describe("3. never exposed to super admin, support views, exports or backups", () => {
  it("support view (owner-granted, read-only) gets 403 on integrations and WhatsApp", async () => {
    const supportAdmin = await signIn(srv.base, (await createPlatformAdmin()).email);
    const setup = await supportAdmin.call("POST", "/auth/2fa/setup");
    expect((await supportAdmin.call("POST", "/auth/2fa/enable", { code: totpAt(setup.body.secret, currentStep()) })).status).toBe(200);
    expect((await ownerA.call("POST", "/support-access", { hours: 1, reason: "Integration check" })).status).toBe(201);
    const as = (p: string) => supportAdmin.call("GET", p, undefined, { "x-support-business": a.businessId, "x-outlet-id": a.outletId });
    expect((await as("/orders")).status).toBe(200); // the grant works…
    for (const p of ["/admin/integrations", "/admin/whatsapp"]) {
      const r = await as(p);
      expect(r.status, p).toBe(403);
      for (const s of ALL_SECRETS) expect(JSON.stringify(r.body)).not.toContain(s);
    }
  });

  it("owner export (JSON and CSV) carries no secrets and no ciphertext of them", async () => {
    for (const format of ["json", "csv-zip"]) {
      const res = await realFetch(`${srv.base}/admin/export?format=${format}`, { headers: { authorization: `Bearer ${ownerA.token}`, "x-outlet-id": a.outletId } });
      expect(res.status).toBe(200);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = format === "json" ? buf.toString("utf8") : await (await JSZip.loadAsync(buf)).file("Setting.csv")!.async("string");
      for (const s of ALL_SECRETS) expect(text, `${format}: ${s}`).not.toContain(s);
      if (format !== "json") {
        expect(text).toContain("integrations.razorpay");
        expect(text).not.toMatch(/Enc""|v1:/);
      } else {
        const settings = (JSON.parse(text).tables.Setting as { key: string; value: object }[]) ?? [];
        const integ = settings.filter((r) => r.key.startsWith("integrations.") || r.key === "whatsapp.config");
        expect(integ.length).toBeGreaterThan(0);
        // Ciphertext is a secret too: encrypted fields are left out of the export.
        expect(JSON.stringify(integ)).not.toMatch(/Enc"|v1:/);
      }
    }
  });

  it("a platform backup holds only ciphertext (the key isn't in the backup)", async () => {
    const { file } = await createBackup("manual");
    try {
      const text = gunzipSync(await readFile(path.join(backupsDir(), file))).toString("utf8");
      expect(text).toContain("integrations.razorpay");
      for (const s of [...ALL_SECRETS, KEYS.a.keyId]) expect(text, s).not.toContain(s);
    } finally {
      await rm(path.join(backupsDir(), file), { force: true });
    }
  });
});

describe("5. one store's keys never serve another", () => {
  it("QRs: A's bill uses A's key, B's bill uses B's key", async () => {
    expect((await ownerB.call("PUT", "/admin/integrations/razorpay", KEYS.b)).status).toBe(200);
    calls.length = 0;
    const oa = await openOrder(cashierA, a);
    const qa = await cashierA.call("POST", `/orders/${oa.id}/upi-qr`, {});
    expect(qa.status, JSON.stringify(qa.body)).toBe(201);
    expect(qa.body.mock).toBe(false);
    const ob = await openOrder(ownerB, b);
    const qb = await ownerB.call("POST", `/orders/${ob.id}/upi-qr`, {});
    expect(qb.status).toBe(201);
    const qrCalls = calls.filter((x) => x.url.endsWith("/v1/payments/qr_codes"));
    expect(qrCalls.map((x) => x.headers.authorization)).toEqual([basicOf(KEYS.a), basicOf(KEYS.b)]);
    expect(qrCalls[0]!.body.notes.orderId).toBe(oa.id);
    for (const r of [qa, qb]) for (const s of ALL_SECRETS) expect(JSON.stringify(r.body)).not.toContain(s);
  });

  it("webhooks: A's secret only works on A's URL, and only for A's payments; B's stay untouched", async () => {
    const urlA = new URL((await ownerA.call("GET", "/admin/integrations")).body.razorpay.webhookUrl).pathname;
    const urlB = new URL((await ownerB.call("GET", "/admin/integrations")).body.razorpay.webhookUrl).pathname;
    expect(urlA).not.toBe(urlB);
    const oa = await openOrder(cashierA, a);
    const pa = (await cashierA.call("POST", `/orders/${oa.id}/upi-qr`, {})).body;
    const ob = await openOrder(ownerB, b);
    const pb = (await ownerB.call("POST", `/orders/${ob.id}/upi-qr`, {})).body;
    const refA = (await db.payment.findUniqueOrThrow({ where: { id: pa.paymentId } })).gatewayRef!;
    const refB = (await db.payment.findUniqueOrThrow({ where: { id: pb.paymentId } })).gatewayRef!;
    const credited = (qr: string, pay: string, amount: number) => JSON.stringify({ event: "qr_code.credited", payload: { qr_code: { entity: { id: qr } }, payment: { entity: { id: pay, amount } } } });

    // B's QR, signed with A's secret, sent to B's URL → rejected
    const forB = credited(refB, "pay_FORGED1", pb.amount);
    expect((await hook(urlB, forB, sign(forB, KEYS.a.webhookSecret))).status).toBe(401);
    // B's QR, signed with A's secret, sent to A's URL → ignored (not A's payment)
    expect((await hook(urlA, forB, sign(forB, KEYS.a.webhookSecret))).body).toEqual({ ignored: "unknown qr" });
    // The legacy platform webhook doesn't touch stores with their own Razorpay
    env.RAZORPAY_WEBHOOK_SECRET = "platform-hook-secret";
    expect((await hook("/webhooks/razorpay", forB, sign(forB, "platform-hook-secret"))).body).toEqual({ ignored: "unknown qr" });
    // Unknown / malformed store ids: the same 401 as a bad signature
    for (const u of ["/webhooks/razorpay/AAAAAAAAAAAAAAAAAAAAAAAA", "/webhooks/razorpay/x", `/webhooks/razorpay/${"A".repeat(300)}`])
      expect((await hook(u, forB, sign(forB, KEYS.a.webhookSecret))).status, u).toBe(401);
    expect(await db.payment.findUniqueOrThrow({ where: { id: pb.paymentId } })).toMatchObject({ status: "PENDING", reference: null });
    expect((await db.order.findUniqueOrThrow({ where: { id: ob.id } })).status).toBe("OPEN");

    // A's own event on A's URL settles A's bill
    const forA = credited(refA, "pay_AOK1", pa.amount);
    const ok = await hook(urlA, forA, sign(forA, KEYS.a.webhookSecret));
    expect(ok).toEqual({ status: 200, body: { ok: true } });
    expect(await db.payment.findUniqueOrThrow({ where: { id: pa.paymentId } })).toMatchObject({ status: "SUCCESS", reference: "pay_AOK1" });
    // B's own secret on B's URL works for B
    expect((await hook(urlB, forB, sign(forB, KEYS.b.webhookSecret))).body).toEqual({ ok: true });
    expect(await db.payment.findUniqueOrThrow({ where: { id: pb.paymentId } })).toMatchObject({ status: "SUCCESS", reference: "pay_FORGED1" });
  });
});

describe("no payment fallback to the platform account", () => {
  it("a store without its own Razorpay: UPI QR refused with a pointer to Settings → Integrations; cash still works", async () => {
    const lone = await createHotel("No Razorpay");
    const owner = await signIn(srv.base, lone.users.owner.email, lone.outletId);
    env.PAYMENTS_DEV_MOCK = false; // what production does
    try {
      calls.length = 0;
      const o = await openOrder(owner, lone);
      const r = await owner.call("POST", `/orders/${o.id}/upi-qr`, {});
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: expect.stringContaining("Settings → Integrations"), details: { code: "RAZORPAY_NOT_CONNECTED" } });
      expect(calls).toHaveLength(0); // nothing went to any Razorpay account
      expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
      const cash = await owner.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] });
      expect(cash.status, JSON.stringify(cash.body)).toBeLessThan(300);
    } finally {
      env.PAYMENTS_DEV_MOCK = saved.mock;
    }
  });

  it("online ordering: without the store's Razorpay, UPI is hidden and refused; once connected, the store's key is used", async () => {
    const h = await createHotel("Online UPI", { modules: ["BILLING", "KOT", "TABLES", "DELIVERY", "CUSTOMERS", "REPORTS", "CHANNELS"] });
    const owner = await signIn(srv.base, h.users.owner.email, h.outletId);
    const slug = `int-${Date.now().toString(36)}`;
    expect((await owner.call("PUT", "/storefront/settings", { slug, onlineOrdering: true, verifyPhoneOtp: false, upiPrepaid: true, payAtCounter: true })).status).toBe(200);
    const pub = (method: string, p: string, body?: unknown) =>
      realFetch(`${srv.base}${p}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const upiOrder = { orderType: "TAKEAWAY", customerName: "Online Uma", customerPhone: "9822200009", payment: "UPI", items: [{ menuItemId: h.items.chai, quantity: 1 }] };
    env.PAYMENTS_DEV_MOCK = false;
    try {
      calls.length = 0;
      expect((await owner.call("GET", "/storefront/settings")).body.upiReady).toBe(false);
      expect((await pub("GET", `/public/o/${slug}`)).body.payments).toMatchObject({ UPI: false, COUNTER: true });
      const refused = await pub("POST", `/public/o/${slug}/orders`, upiOrder);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/Online UPI payment isn't available/);
      expect(await db.channelRequest.count({ where: { outletId: h.outletId } })).toBe(0);
      expect(calls).toHaveLength(0);
      // Paying at the counter still works
      expect((await pub("POST", `/public/o/${slug}/orders`, { ...upiOrder, payment: "COUNTER" })).status).toBe(201);

      expect((await owner.call("PUT", "/admin/integrations/razorpay", { ...KEYS.b, keyId: "rzp_test_ONLINE0001" })).status).toBe(200);
      expect((await owner.call("GET", "/storefront/settings")).body.upiReady).toBe(true);
      expect((await pub("GET", `/public/o/${slug}`)).body.payments.UPI).toBe(true);
      const ok = await pub("POST", `/public/o/${slug}/orders`, upiOrder);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const qr = calls.filter((x) => x.url.endsWith("/v1/payments/qr_codes"));
      expect(qr.map((x) => x.headers.authorization)).toEqual([basicOf({ ...KEYS.b, keyId: "rzp_test_ONLINE0001" })]);
    } finally {
      env.PAYMENTS_DEV_MOCK = saved.mock;
    }
  });

  it("development keeps the mock QR (never a platform key)", async () => {
    const lone = await createHotel("Dev mock");
    const owner = await signIn(srv.base, lone.users.owner.email, lone.outletId);
    calls.length = 0;
    const o = await openOrder(owner, lone);
    const r = await owner.call("POST", `/orders/${o.id}/upi-qr`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mock: true, qrPayload: expect.stringMatching(/^upi:\/\/pay\?/) });
    expect(calls).toHaveLength(0);
  });
});

describe("4. no keys in logs or error bodies", () => {
  const leaks = (text: string) => [...ALL_SECRETS, KEYS.a.keyId, KEYS.b.keyId, basicOf(KEYS.a).slice(6)].filter((s) => text.includes(s));

  it("Razorpay QR failure that echoes the keys → clean 502, nothing logged", async () => {
    replies.set(`${RZP}/v1/payments/qr_codes`, (call) =>
      new Response(JSON.stringify({ error: { description: `Bad auth ${call.headers.authorization} key=${KEYS.a.keyId} secret=${KEYS.a.keySecret}` } }), { status: 400 }),
    );
    try {
      const o = await openOrder(cashierA, a);
      const r = await cashierA.call("POST", `/orders/${o.id}/upi-qr`, {});
      expect(r.status).toBe(502);
      expect(r.body.error).toMatch(/^Razorpay couldn't create the QR: 400/);
      expect(leaks(JSON.stringify(r.body))).toEqual([]);
      expect(leaks(printed.join("\n"))).toEqual([]);
    } finally {
      replies.clear();
    }
  });

  it("Razorpay test connection: 401 that echoes the key → short message, no key", async () => {
    replies.set(`${RZP}/v1/payments?count=1`, (call) => new Response(JSON.stringify({ error: { description: `The api key provided is invalid: ${KEYS.a.keyId} ${call.headers.authorization}` } }), { status: 401 }));
    try {
      const r = await ownerA.call("POST", "/admin/integrations/razorpay/test", {});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: false, message: "Razorpay refused the key ID or secret", webhookSecret: true });
      replies.set(`${RZP}/v1/payments?count=1`, () => new Response(JSON.stringify({ error: { description: `echo ${KEYS.a.keySecret} ${KEYS.a.keyId}` } }), { status: 500 }));
      const r2 = await ownerA.call("POST", "/admin/integrations/razorpay/test", {});
      expect(r2.body.ok).toBe(false);
      expect(leaks(JSON.stringify(r2.body))).toEqual([]);
      expect(leaks(printed.join("\n"))).toEqual([]);
    } finally {
      replies.clear();
    }
    const ok = await ownerA.call("POST", "/admin/integrations/razorpay/test", {});
    expect(ok.body).toEqual({ ok: true, message: "Connected (test mode)", webhookSecret: true });
    expect(calls.at(-1)!.headers.authorization).toBe(basicOf(KEYS.a));
  });

  it("SMTP verify / send failures that echo the password → no password anywhere", async () => {
    smtp.verify.error = Object.assign(new Error(`535 Authentication failed for billing@hotel.in with password ${SMTP_PASS}`), { code: "EAUTH", responseCode: 535 });
    try {
      const r = await ownerA.call("POST", "/admin/integrations/smtp/test", {});
      expect(r.body).toEqual({ ok: false, message: "The mail server refused the user name or password" });
      expect(leaks(printed.join("\n"))).toEqual([]);
    } finally {
      smtp.verify.error = null;
    }
    const ok = await ownerA.call("POST", "/admin/integrations/smtp/test", {});
    expect(ok.body).toEqual({ ok: true, message: "Connected and signed in" });
    const t = smtp.created.at(-1)!;
    expect(t).toMatchObject({ host: "203.0.113.25", port: 587, secure: false, auth: { user: "billing@hotel.in", pass: SMTP_PASS } });
  });

  it("MSG91 failure that echoes the auth key → redacted in the result, the thrown error and logs", async () => {
    replies.set("https://control.msg91.com/", (call) => new Response(JSON.stringify({ type: "error", message: `Invalid authkey ${call.headers.authkey}` }), { status: 400 }));
    try {
      const r = await ownerA.call("POST", "/admin/integrations/sms/test", { phone: "9876543210" });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(leaks(JSON.stringify(r.body))).toEqual([]);
      const err = await runForBusiness(a.businessId, () => sendSms("9876543210", "hello")).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("[redacted]");
      expect(leaks((err as Error).message)).toEqual([]);
      expect(leaks(printed.join("\n"))).toEqual([]);
    } finally {
      replies.clear();
    }
    const ok = await ownerA.call("POST", "/admin/integrations/sms/test", { phone: "+919876543210" });
    expect(ok.body).toEqual({ ok: true, message: "Test SMS sent to 9876543210" });
    expect(calls.at(-1)).toMatchObject({ url: "https://control.msg91.com/api/v5/flow", headers: { authkey: MSG91_KEY }, body: { template_id: "alertTPL123456" } });
  });
});

describe("6. test buttons: no probing of internal hosts, rate-limited", () => {
  it("SMTP: internal / metadata hosts and odd ports refused on save", async () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.10", "169.254.169.254", "metadata.google.internal", "mail.internal", "smtp.local", "0.0.0.0", "100.64.0.1"]) {
      const r = await ownerB.call("PUT", "/admin/integrations/smtp", { host, port: 587, from: "a@b.in" });
      expect(r.status, host).toBe(400);
    }
    for (const port of [22, 80, 3306, 5432, 6379, 0, 65536]) expect((await ownerB.call("PUT", "/admin/integrations/smtp", { host: "smtp.gmail.com", port, from: "a@b.in" })).status, String(port)).toBe(400);
    expect(await db.setting.findUnique({ where: { scope_key: { scope: b.businessId, key: "integrations.smtp" } } })).toBeNull();
  });

  it("SMTP: a public name that resolves to an internal address is refused at connect time (DNS rebinding)", async () => {
    const creds = { host: "smtp.evil.example", port: 587, secure: false, from: "a@b.in", source: "store" as const };
    await expect(smtpConnectTarget(creds, async () => ["10.1.2.3"])).rejects.toThrow(/internal network/);
    await expect(smtpConnectTarget(creds, async () => ["93.184.216.34", "169.254.169.254"])).rejects.toThrow(/internal network/);
    await expect(smtpConnectTarget(creds, async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/not found/);
    expect(await smtpConnectTarget(creds, async () => ["93.184.216.34"])).toEqual({ host: "93.184.216.34", servername: "smtp.evil.example" });
    // A saved row someone edited in the database is re-checked too
    expect(await smtpConnectTarget({ ...creds, host: "127.0.0.1" }).catch((e: Error) => e.message)).toMatch(/internal address/);
  });

  it("WATI API URL can't point at an internal address (test button SSRF)", async () => {
    for (const apiUrl of ["https://169.254.169.254/latest", "https://localhost:8443", "https://10.0.0.8", "https://wati.internal/x"])
      expect((await ownerB.call("PUT", "/admin/whatsapp", { provider: "WATI", wati: { apiUrl, token: "x".repeat(20) } })).status, apiUrl).toBe(400);
  });

  it("test buttons: 10 per 15 minutes per store, then 429 (another store unaffected)", async () => {
    const h = await createHotel("Rate limit");
    const o = await signIn(srv.base, h.users.owner.email, h.outletId);
    expect((await o.call("PUT", "/admin/integrations/razorpay", KEYS.b)).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await o.call("POST", "/admin/integrations/razorpay/test", {})).status);
    expect(codes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    // Fresh sign-in from another address doesn't reset it (keyed by store, not IP)
    const again = await signIn(srv.base, h.users.owner.email, h.outletId);
    expect((await again.call("POST", "/admin/integrations/razorpay/test", {})).status).toBe(429);
    expect((await ownerB.call("POST", "/admin/integrations/razorpay/test", {})).status).toBe(200);
  });
});

describe("email and SMS fall back to the platform account", () => {
  it("email: the store's own server when set, else the platform's (.env)", async () => {
    Object.assign(env, { SMTP_HOST: "smtp.platform.test", SMTP_FROM: "CANAVO <no-reply@canavo.test>" });
    try {
      smtp.sent.length = 0;
      await runForBusiness(a.businessId, () => sendMail({ to: "x@y.in", subject: "A report", html: "<p>x</p>" }));
      await runForBusiness(b.businessId, () => sendMail({ to: "x@y.in", subject: "B report", html: "<p>x</p>" }));
      expect(smtp.sent.map((m) => [m.subject, m.from, (m.transport as { host: string }).host])).toEqual([
        ["A report", "billing@hotel.in", "203.0.113.25"],
        ["B report", "CANAVO <no-reply@canavo.test>", "smtp.platform.test"],
      ]);
      // A password reset for a store's staff goes out through the store's mail server
      smtp.sent.length = 0;
      const r = await ownerA.call("POST", `/staff/${c.ids.CASHIER}/reset-link`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(smtp.sent).toHaveLength(1);
      expect((smtp.sent[0]!.transport as { host: string }).host).toBe("203.0.113.25");
    } finally {
      Object.assign(env, { SMTP_HOST: saved.smtpHost, SMTP_FROM: saved.smtpFrom });
    }
  });

  it("SMS: the store's MSG91 for its OTP / alerts, else the platform's", async () => {
    Object.assign(env, { MSG91_AUTH_KEY: "platformKey0123456789", MSG91_TEMPLATE_ID: "platOTP1", MSG91_ALERT_TEMPLATE_ID: "platALERT1" });
    try {
      calls.length = 0;
      expect(await runForBusiness(a.businessId, () => sendOtpSms("9876500001", "123456"))).toBe(true);
      expect(await runForBusiness(b.businessId, () => sendOtpSms("9876500002", "654321"))).toBe(true);
      expect(await sendSms("9876500003", "platform alert")).toBe(true); // no store at all
      expect(calls.map((x) => [x.headers.authkey, x.body.template_id])).toEqual([
        [MSG91_KEY, "otpTPL123456"],
        ["platformKey0123456789", "platOTP1"],
        ["platformKey0123456789", "platALERT1"],
      ]);
      // Staff login OTP (no session yet) uses the staff member's store account
      calls.length = 0;
      const cashier = await db.user.findUniqueOrThrow({ where: { id: c.ids.CASHIER } });
      const otp = await realFetch(`${srv.base}/auth/otp/request`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.200.1.1" }, body: JSON.stringify({ phone: cashier.phone }) });
      expect(otp.status).toBe(200);
      expect(calls.map((x) => x.headers.authkey)).toEqual([MSG91_KEY]);
    } finally {
      Object.assign(env, { MSG91_AUTH_KEY: saved.msgKey, MSG91_TEMPLATE_ID: saved.msgOtp, MSG91_ALERT_TEMPLATE_ID: saved.msgAlert });
    }
  });

  it("removing an integration goes back to the fallback (Razorpay: none)", async () => {
    const h = await createHotel("Disconnect");
    const o = await signIn(srv.base, h.users.owner.email, h.outletId);
    expect((await o.call("PUT", "/admin/integrations/razorpay", { ...KEYS.b, keyId: "rzp_test_DISCONNECT01" })).status).toBe(200);
    const url = new URL((await o.call("GET", "/admin/integrations")).body.razorpay.webhookUrl).pathname;
    const del = await o.call("DELETE", "/admin/integrations/razorpay");
    expect(del.body).toMatchObject({ connected: false, keyId: null, platformFallback: false });
    expect(await db.setting.findUnique({ where: { scope_key: { scope: h.businessId, key: "integrations.razorpay" } } })).toBeNull();
    const raw = JSON.stringify({ event: "qr_code.credited", payload: {} });
    expect((await hook(url, raw, sign(raw, KEYS.b.webhookSecret))).status).toBe(401);
    expect((await auditsOf(h, "integration.razorpay.remove")).length).toBe(1);
    expect((await o.call("DELETE", "/admin/integrations/smtp")).body.connected).toBe(false);
    expect((await o.call("DELETE", "/admin/integrations/sms")).body.connected).toBe(false);
  });
});

describe("WhatsApp templates", () => {
  it("per-purpose template name + language; test send uses them with the sample values", async () => {
    const put = await ownerA.call("PUT", "/admin/whatsapp", {
      provider: "META",
      meta: { phoneNumberId: "1234567890", language: "en" },
      templates: { receipt: "bill_receipt_v2" },
      templateLanguages: { receipt: "en_US", birthday: "ta" },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const g = await ownerA.call("GET", "/admin/whatsapp");
    expect(g.body).toMatchObject({ templates: { receipt: "bill_receipt_v2" }, templateLanguages: { receipt: "en_US", birthday: "ta" }, meta: { token: "••••ABCD" } });
    expect(JSON.stringify(g.body)).not.toContain(META_TOKEN);

    calls.length = 0;
    const t = await ownerA.call("POST", "/admin/whatsapp/templates/receipt/test", { phone: "9876543210" });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body).toMatchObject({ method: "sent", provider: "META", template: "bill_receipt_v2", language: "en_US" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${META_TOKEN}`);
    expect(calls[0]!.body.template).toEqual({
      name: "bill_receipt_v2",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: ["Hotel Saravana", "INV-2026-0142", "₹482.00", "https://canavo.in/r/abc123"].map((text) => ({ type: "text", text })) }],
    });
    // Other purposes keep the default name and the account language
    await ownerA.call("POST", "/admin/whatsapp/templates/khata_reminder/test", { phone: "9876543210" });
    expect(calls.at(-1)!.body.template).toMatchObject({ name: "khata_reminder", language: { code: "en" } });
    expect((await auditsOf(a, "whatsapp.template_test")).length).toBe(2);
  });

  it("a Meta failure echoing the token is redacted; bad input → 400", async () => {
    replies.set(META, () => new Response(JSON.stringify({ error: { message: `Malformed access token ${META_TOKEN}` } }), { status: 401 }));
    try {
      const r = await ownerA.call("POST", "/admin/whatsapp/templates/birthday/test", { phone: "9876543210" });
      expect(r.status).toBe(200);
      expect(r.body.method).toBe("link");
      expect(JSON.stringify(r.body)).not.toContain(META_TOKEN);
      expect(printed.join("\n")).not.toContain(META_TOKEN);
      expect(JSON.stringify(await auditsOf(a, "whatsapp."))).not.toContain(META_TOKEN);
    } finally {
      replies.clear();
    }
    expect((await ownerA.call("POST", "/admin/whatsapp/templates/evil/test", { phone: "9876543210" })).status).toBe(400);
    expect((await ownerA.call("POST", "/admin/whatsapp/templates/receipt/test", { phone: "123" })).status).toBe(400);
    expect((await ownerA.call("POST", "/admin/whatsapp/templates/receipt/test", {})).status).toBe(400);
    for (const templateLanguages of [{ receipt: "English" }, { receipt: "en-US" }, { evil: "en" }, { receipt: 5 }])
      expect((await ownerA.call("PUT", "/admin/whatsapp", { provider: "NONE", templateLanguages })).status, JSON.stringify(templateLanguages)).toBe(400);
  });
});
