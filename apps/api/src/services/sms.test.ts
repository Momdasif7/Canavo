import { afterEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ env: { NODE_ENV: "production" } as Record<string, unknown>, isProd: true }));
vi.mock("../env", () => envMock);

import { sendOtpSms } from "./sms";

describe("OTP SMS fallback logging (BUG-015)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("SEC-LOG-001 never writes the OTP to logs in production when SMS isn't configured", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendOtpSms("9876543210", "482913")).toBe(false);
    const logged = [...spy.mock.calls, ...warn.mock.calls, ...err.mock.calls].flat().join(" ");
    expect(logged).not.toContain("482913");
    expect(logged).not.toContain("9876543210");
  });

  it("SEC-LOG-002 still prints the dev OTP outside production", async () => {
    envMock.env.NODE_ENV = "development";
    envMock.isProd = false;
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await sendOtpSms("9876543210", "482913");
    expect(spy.mock.calls.flat().join(" ")).toContain("482913");
  });
});
