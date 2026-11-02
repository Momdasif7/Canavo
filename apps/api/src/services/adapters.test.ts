/**
 * Third-party adapters with their documented dev fallbacks (no real credentials):
 * Razorpay UPI QR + webhook signature, WhatsApp share (WATI / wa.me).
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined>, isProd: false }));
vi.mock("../env", () => envMock);

import { createUpiQr, razorpayEnabled, verifyWebhookSignature } from "./razorpay";
import { shareReceipt } from "./whatsapp";

const SECRET = "whsec_test_only_0123456789";
beforeEach(() => {
  for (const k of Object.keys(envMock.env)) delete envMock.env[k];
  envMock.env.WATI_RECEIPT_TEMPLATE = "receipt_share";
});
afterEach(() => vi.restoreAllMocks());

describe("Razorpay webhook signature (SEC-RZP)", () => {
  const body = Buffer.from(JSON.stringify({ event: "qr_code.credited", payload: { qr_code: { entity: { id: "qr_1" } } } }));
  const sign = (b: Buffer, s = SECRET) => crypto.createHmac("sha256", s).update(b).digest("hex");

  it("SEC-RZP-001 accepts the correct HMAC-SHA256 of the raw body", () => {
    envMock.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });
  it("SEC-RZP-002 rejects a tampered body, a wrong secret, a truncated or missing signature", () => {
    envMock.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    const tampered = Buffer.from(body.toString().replace("qr_1", "qr_2"));
    expect(verifyWebhookSignature(tampered, sign(body))).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, "other-secret"))).toBe(false);
    expect(verifyWebhookSignature(body, sign(body).slice(0, 32))).toBe(false);
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, "")).toBe(false);
  });
  it("SEC-RZP-003 fails closed when no webhook secret is configured", () => {
    expect(verifyWebhookSignature(body, sign(body))).toBe(false);
  });
});

describe("UPI QR (UT-UPI)", () => {
  it("UT-UPI-001 without Razorpay: a upi:// intent to the outlet's VPA with the exact amount", async () => {
    expect(razorpayEnabled()).toBe(false);
    const qr = await createUpiQr({ amount: 12345, orderId: "o1", invoiceNumber: "INV-2026-00001", payeeName: "Saravana", vpa: "saravana@okhdfc" });
    expect(qr.mock).toBe(true);
    const u = new URL(qr.qrPayload);
    expect(u.protocol).toBe("upi:");
    expect(u.searchParams.get("pa")).toBe("saravana@okhdfc");
    expect(u.searchParams.get("am")).toBe("123.45");
    expect(u.searchParams.get("cu")).toBe("INR");
    expect(u.searchParams.get("tr")).toBe(qr.gatewayRef);
  });

  it("UT-UPI-002 (BUG-023) without Razorpay and without an outlet UPI ID, no QR is generated (never a placeholder payee)", async () => {
    await expect(createUpiQr({ amount: 5000, orderId: "o1", invoiceNumber: "INV-1", payeeName: "X", vpa: null })).rejects.toThrow(/UPI ID/);
    await expect(createUpiQr({ amount: 5000, orderId: "o1", invoiceNumber: "INV-1", payeeName: "X", vpa: "" })).rejects.toThrow(/UPI ID/);
  });

  it("UT-UPI-003 with Razorpay keys: single-use fixed-amount QR, 15-minute expiry, order notes", async () => {
    envMock.env.RAZORPAY_KEY_ID = "rzp_test_x";
    envMock.env.RAZORPAY_KEY_SECRET = "secret_x";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "qr_abc", image_url: "https://rzp.io/qr.png" }), { status: 200 }));
    const qr = await createUpiQr({ amount: 9900, orderId: "o9", invoiceNumber: "INV-2026-00009", payeeName: "A very long outlet name that exceeds forty characters easily", vpa: null });
    expect(qr).toEqual({ gatewayRef: "qr_abc", qrPayload: "https://rzp.io/qr.png", imageUrl: "https://rzp.io/qr.png", mock: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as { name: string; close_by: number };
    expect(body).toMatchObject({ type: "upi_qr", usage: "single_use", fixed_amount: true, payment_amount: 9900, notes: { orderId: "o9" } });
    expect(body.name.length).toBeLessThanOrEqual(40);
    expect(body.close_by - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60);
    expect(String((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
  });

  it("UT-UPI-004 Razorpay error surfaces (no silent mock QR)", async () => {
    envMock.env.RAZORPAY_KEY_ID = "rzp_test_x";
    envMock.env.RAZORPAY_KEY_SECRET = "secret_x";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 401 }));
    await expect(createUpiQr({ amount: 100, orderId: "o", invoiceNumber: "I", payeeName: "X", vpa: "x@y" })).rejects.toThrow(/Razorpay QR failed: 401/);
  });
});

describe("WhatsApp receipt share (UT-WA)", () => {
  const opts = { phone: "9876543210", outletName: "Saravana", invoiceNumber: "INV-2026-00042", amountText: "₹168.00", receiptUrl: "https://api.example/public/receipts/t" };

  it("UT-WA-001 without WATI: wa.me link to +91 number with the URL-encoded text", async () => {
    const r = await shareReceipt(opts);
    expect(r.method).toBe("link");
    expect(r.waLink.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(r.waLink.split("text=")[1])).toContain("Bill INV-2026-00042 — ₹168.00");
  });

  it("UT-WA-002 with WATI: sends the template; on an HTTP error falls back to the link", async () => {
    envMock.env.WATI_API_URL = "https://wati.test";
    envMock.env.WATI_API_TOKEN = "t";
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await shareReceipt(opts)).method).toBe("sent");
    expect(f.mock.calls[0][0] as string).toContain("whatsappNumber=919876543210");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect((await shareReceipt(opts)).method).toBe("link");
  });

  it("UT-WA-003 (BUG-024) a WATI network failure falls back to the link instead of failing the request", async () => {
    envMock.env.WATI_API_URL = "https://wati.test";
    envMock.env.WATI_API_TOKEN = "t";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(shareReceipt(opts)).resolves.toMatchObject({ method: "link" });
  });
});
