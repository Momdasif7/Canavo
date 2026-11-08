import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { productionConfigProblems } from "../env";
import { createLogger, logUrl } from "./observability";

describe("structured logs", () => {
  it("redact passwords, PINs, OTPs, tokens and Aadhaar", () => {
    const lines: string[] = [];
    const log = createLogger(new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.info({ body: { email: "a@b.in", password: "Secret@123", pin: "1234", otp: "998877", aadhaar: "234123412346", refreshToken: "rt-xyz" } }, "login");
    const out = lines.join("");
    expect(out).toContain("a@b.in");
    for (const secret of ["Secret@123", "1234", "998877", "234123412346", "rt-xyz"]) expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });
});

describe("production config fail-fast", () => {
  const base = {
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    RECEIPT_LINK_SECRET: "c".repeat(40),
    DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    PUBLIC_API_URL: "https://api.example.in",
    CORS_ORIGINS: "https://app.example.in",
    WEB_APP_URL: "https://app.example.in",
    SMTP_HOST: "smtp.example.in",
  } as never;
  it("accepts a sane production configuration", () => expect(productionConfigProblems(base)).toEqual([]));
  it("refuses placeholder secrets, a missing encryption key, localhost URLs and CORS *", () => {
    const p = productionConfigProblems({
      ...(base as object),
      JWT_ACCESS_SECRET: "change-me-access-secret-at-least-32-chars",
      DATA_ENCRYPTION_KEY: undefined,
      PUBLIC_API_URL: "http://localhost:4000",
      CORS_ORIGINS: "*",
    } as never);
    expect(p.join(" | ")).toMatch(/JWT_ACCESS_SECRET.*placeholder/);
    expect(p.join(" | ")).toMatch(/DATA_ENCRYPTION_KEY/);
    expect(p.join(" | ")).toMatch(/localhost/);
    expect(p.join(" | ")).toMatch(/CORS_ORIGINS/);
  });
  it("D13: refuses production without email or SMS for password links; either one is enough", () => {
    const none = productionConfigProblems({ ...(base as object), SMTP_HOST: undefined, MSG91_AUTH_KEY: undefined } as never);
    expect(none.join()).toMatch(/SMTP_HOST.*MSG91_AUTH_KEY/);
    expect(productionConfigProblems({ ...(base as object), SMTP_HOST: undefined, MSG91_AUTH_KEY: "k" } as never).join()).toMatch(/MSG91_ALERT_TEMPLATE_ID/);
    expect(productionConfigProblems({ ...(base as object), SMTP_HOST: undefined, MSG91_AUTH_KEY: "k", MSG91_ALERT_TEMPLATE_ID: "t" } as never)).toEqual([]);
    expect(productionConfigProblems({ ...(base as object), WEB_APP_URL: "http://localhost:3000" } as never).join()).toMatch(/WEB_APP_URL/);
  });
  it("refuses identical secrets", () => {
    expect(productionConfigProblems({ ...(base as object), JWT_REFRESH_SECRET: "a".repeat(40) } as never).join()).toMatch(/must all differ/);
  });
  it("does nothing outside production", () => expect(productionConfigProblems({ ...(base as object), NODE_ENV: "development", DATA_ENCRYPTION_KEY: undefined } as never)).toEqual([]));
});

describe("QA Phase 8 (sec1-7): logs carry no phone numbers, CSRF tokens, 2FA secrets or receipt links", () => {
  it("redacts phones, CSRF header, two-step tickets/recovery codes and password-change fields", () => {
    const lines: string[] = [];
    const log = createLogger(new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }));
    log.info(
      {
        req: { headers: { "x-csrf-token": "csrf-abc-123" } },
        body: { phone: "9876501234", customerPhone: "9876505678", mfaToken: "mfa.jwt.xyz", recoveryCode: "ABCD-EFGH", currentPassword: "Old@Pass1", newPassword: "New@Pass2", aadhaarNumber: "234123412346" },
      },
      "x",
    );
    const out = lines.join("");
    for (const secret of ["csrf-abc-123", "9876501234", "9876505678", "mfa.jwt.xyz", "ABCD-EFGH", "Old@Pass1", "New@Pass2", "234123412346"]) expect(out).not.toContain(secret);
  });

  it("request URLs in access logs hide receipt / order tokens", () => {
    expect(logUrl("/public/receipts/eyJhbGciOi.sig?x=1")).toBe("/public/receipts/[token]");
    expect(logUrl("/public/o/my-cafe/orders/abc123def/upi")).toBe("/public/o/my-cafe/orders/[token]/upi");
    expect(logUrl("/orders/abc?phone=9876501234")).toBe("/orders/abc");
  });
});

describe("QA Phase 8 (sec1-8): TRUST_PROXY", () => {
  const base = {
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    RECEIPT_LINK_SECRET: "c".repeat(40),
    DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    PUBLIC_API_URL: "https://api.example.in",
    CORS_ORIGINS: "https://app.example.in",
    WEB_APP_URL: "https://app.example.in",
    SMTP_HOST: "smtp.example.in",
    TRUST_PROXY: "loopback, linklocal, uniquelocal",
  };
  it("production refuses trust-everyone settings (any client could fake X-Forwarded-For and dodge per-IP limits)", () => {
    expect(productionConfigProblems(base as never)).toEqual([]);
    for (const bad of ["true", "TRUE", "*", "0.0.0.0/0", "::/0"]) expect(productionConfigProblems({ ...base, TRUST_PROXY: bad } as never).join(), bad).toMatch(/TRUST_PROXY/);
    // A hop count or named proxies stay allowed.
    expect(productionConfigProblems({ ...base, TRUST_PROXY: "1" } as never)).toEqual([]);
  });
});
