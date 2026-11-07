import { describe, expect, it } from "vitest";
import { openSecret, razorpayWebhookId, redact, sealSecret, smtpConnectTarget, smtpHostError, upiDevMock } from "./integrations";
import { env } from "../env";

describe("redact", () => {
  it("removes every known secret and key=value / auth header shapes", () => {
    const secret = "AsecretAAAAAAAAAAAAAAAA1";
    const out = redact(`bad key ${secret} (again ${secret}) authorization: Basic cnpwX3Rlc3RfQUFBQTpzZWNyZXQ= authkey=abc123xyz password: hunter2!! Bearer EAAGtoken12345`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/cnpwX3Rlc3RfQUFBQTpzZWNyZXQ=|abc123xyz|hunter2|EAAGtoken12345/);
    expect(out).toContain("[redacted]");
  });

  it("ignores empty / very short values (would wipe ordinary text)", () => {
    expect(redact("plain text 401", ["", undefined, null, "ab"])).toBe("plain text 401");
  });
});

describe("secret sealing", () => {
  it("round-trips, never stores plaintext, and a broken ciphertext opens to empty", () => {
    const enc = sealSecret("rzp_live_ABCDEFGH1234");
    expect(enc).toMatch(/^v1:/);
    expect(enc).not.toContain("ABCDEFGH1234");
    expect(openSecret(enc)).toBe("rzp_live_ABCDEFGH1234");
    expect(openSecret("v1:bad:bad:bad")).toBe("");
    expect(openSecret(undefined)).toBe("");
  });

  it("webhook ids are stable per store, different across stores, URL-safe", () => {
    expect(razorpayWebhookId("biz1")).toBe(razorpayWebhookId("biz1"));
    expect(razorpayWebhookId("biz1")).not.toBe(razorpayWebhookId("biz2"));
    expect(razorpayWebhookId("biz1")).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe("SMTP host checks (SSRF)", () => {
  it.each(["localhost", "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.2", "169.254.169.254", "metadata.google.internal", "box.local", "intranet"])("%s is refused", (host) => {
    expect(smtpHostError(host)).not.toBeNull();
  });
  it.each(["smtp.gmail.com", "smtp.zoho.in", "email-smtp.ap-south-1.amazonaws.com", "203.0.113.9"])("%s is fine", (host) => {
    expect(smtpHostError(host)).toBeNull();
  });

  it("platform (.env) servers are trusted as configured; store servers are resolved and checked", async () => {
    const base = { port: 587, secure: false, from: "a@b.in" };
    expect(await smtpConnectTarget({ ...base, host: "localhost", source: "platform" })).toEqual({ host: "localhost" });
    await expect(smtpConnectTarget({ ...base, host: "smtp.x.in", source: "store" }, async () => ["fd00::1"])).rejects.toThrow(/internal/);
    await expect(smtpConnectTarget({ ...base, host: "smtp.x.in", source: "store" }, async () => [])).rejects.toThrow(/internal/);
  });
});

describe("UPI dev mock", () => {
  it("on outside production unless switched off; never in production", () => {
    const saved = { node: env.NODE_ENV, mock: env.PAYMENTS_DEV_MOCK };
    try {
      env.PAYMENTS_DEV_MOCK = undefined;
      expect(upiDevMock()).toBe(true);
      env.PAYMENTS_DEV_MOCK = false;
      expect(upiDevMock()).toBe(false);
      Object.assign(env, { NODE_ENV: "production", PAYMENTS_DEV_MOCK: true });
      expect(upiDevMock()).toBe(false);
    } finally {
      Object.assign(env, { NODE_ENV: saved.node, PAYMENTS_DEV_MOCK: saved.mock });
    }
  });
});
