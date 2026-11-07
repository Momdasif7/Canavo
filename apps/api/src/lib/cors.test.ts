import { describe, expect, it } from "vitest";
import { allowedOrigin } from "./cors";

const check = (list: string, origin?: string) =>
  new Promise<boolean>((resolve) => allowedOrigin(list)(origin, (_e, ok) => resolve(Boolean(ok))));

describe("CORS origins", () => {
  it("allows exact origins (trailing slash ignored)", async () => {
    expect(await check("https://app.canavo.in, http://localhost:3000", "https://app.canavo.in")).toBe(true);
    expect(await check("https://app.canavo.in/", "https://app.canavo.in")).toBe(true);
  });
  it("supports a subdomain wildcard for Vercel previews", async () => {
    expect(await check("https://*.vercel.app", "https://canavo-git-main-team.vercel.app")).toBe(true);
    expect(await check("https://*.vercel.app", "https://vercel.app.evil.com")).toBe(false);
    expect(await check("https://*.vercel.app", "https://a.b.vercel.app")).toBe(false);
    expect(await check("https://*.vercel.app", "http://x.vercel.app")).toBe(false);
  });
  it("refuses other origins and allows requests without Origin (mobile, server)", async () => {
    expect(await check("https://app.canavo.in", "https://evil.example")).toBe(false);
    expect(await check("https://app.canavo.in", undefined)).toBe(true);
  });
});
