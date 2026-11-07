import { describe, expect, it } from "vitest";
import {
  maskSecret,
  razorpayIntegrationSchema,
  renderWaPreview,
  smsIntegrationSchema,
  smtpIntegrationSchema,
  WA_TEMPLATE_CATALOG,
  WA_TEMPLATE_PURPOSES,
  waSamplePreview,
} from "./integrations";

describe("maskSecret", () => {
  it("keeps the Razorpay prefix and the last 4 only", () => {
    expect(maskSecret("rzp_live_ABCDEFGH4f2a")).toBe("rzp_live_••••4f2a");
    expect(maskSecret("rzp_test_ABCDEFGH9999")).toBe("rzp_test_••••9999");
    expect(maskSecret("EAAG-token-ABCD")).toBe("••••ABCD");
    expect(maskSecret("short")).toBe("••••");
    expect(maskSecret("")).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
  });
});

describe("WhatsApp template preview", () => {
  it("fills {{n}} in order and leaves missing ones visible", () => {
    expect(renderWaPreview("Hi {{1}}, bill {{2}} ({{ 3 }})", ["Ravi", "INV-1"])).toBe("Hi Ravi, bill INV-1 ({{ 3 }})");
  });

  it("every purpose's sample text uses exactly its variables", () => {
    for (const p of WA_TEMPLATE_PURPOSES) {
      const info = WA_TEMPLATE_CATALOG[p];
      const used = new Set([...info.sampleText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      expect([...used].sort(), p).toEqual(info.variables.map((_, i) => i + 1));
      expect(waSamplePreview(p), p).not.toMatch(/\{\{\d+\}\}/);
    }
    expect(waSamplePreview("receipt")).toContain("INV-2026-0142");
  });
});

describe("integration schemas", () => {
  it("razorpay: blank means keep; strict; key formats", () => {
    expect(razorpayIntegrationSchema.parse({ keyId: "", keySecret: " ", webhookSecret: "" })).toEqual({});
    expect(razorpayIntegrationSchema.safeParse({ keyId: "rzp_live_ABCDEFGH" }).success).toBe(true);
    for (const bad of [{ keyId: "key_live_ABCDEFGH" }, { keySecret: "has space 123456" }, { webhookSecret: "short" }, { extra: 1 }])
      expect(razorpayIntegrationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("smtp: allowed ports only, host names, from address", () => {
    const ok = { host: "SMTP.Gmail.com", port: 465, from: "Hotel <a@b.in>" };
    expect(smtpIntegrationSchema.parse(ok).host).toBe("smtp.gmail.com");
    for (const bad of [{ ...ok, port: 22 }, { ...ok, host: "smtp" }, { ...ok, host: "a b.com" }, { ...ok, from: "Hotel <a@b.in" }, { ...ok, from: "nope" }])
      expect(smtpIntegrationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("sms: auth key and template id formats", () => {
    expect(smsIntegrationSchema.safeParse({ authKey: "abcdefghij0123456789", otpTemplateId: "6512ab34cd" }).success).toBe(true);
    expect(smsIntegrationSchema.safeParse({ authKey: "short" }).success).toBe(false);
    expect(smsIntegrationSchema.safeParse({ alertTemplateId: "x y" }).success).toBe(false);
  });
});
