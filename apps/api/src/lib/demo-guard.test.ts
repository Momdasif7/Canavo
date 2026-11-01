import { describe, expect, it } from "vitest";
import { assertNoDemoLogins, findDemoLogins } from "./demo-guard";

const db = (emails: (string | null)[]) => ({ user: { findMany: async () => emails.map((email) => ({ email })) } });

describe("demo login guard (Phase 2.8)", () => {
  it("finds seeded demo logins", async () => {
    expect(await findDemoLogins(db(["owner@canavo.local", "OWNER2@CANAVO.LOCAL", "real@hotel.in", null]))).toEqual(["owner@canavo.local", "OWNER2@CANAVO.LOCAL"]);
  });

  it("refuses to start in production while demo logins exist", async () => {
    await expect(assertNoDemoLogins(db(["owner@canavo.local"]), { NODE_ENV: "production" })).rejects.toThrow(/Refusing to start in production: 1 demo login/);
  });

  it("allows production without demo logins, development always, and an explicit throwaway demo", async () => {
    await expect(assertNoDemoLogins(db([]), { NODE_ENV: "production" })).resolves.toBeUndefined();
    await expect(assertNoDemoLogins(db(["owner@canavo.local"]), { NODE_ENV: "development" })).resolves.toBeUndefined();
    await expect(assertNoDemoLogins(db(["owner@canavo.local"]), { NODE_ENV: "production", ALLOW_DEMO_SEED: "1" })).resolves.toBeUndefined();
  });
});

describe("demo seed (Phase 2.8)", () => {
  it("refuses to run with NODE_ENV=production", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const r = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", ALLOW_DEMO_SEED: "", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to seed demo data in production/);
  }, 40_000);
});
