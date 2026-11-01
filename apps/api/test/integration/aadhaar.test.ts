/** Phase 2.5 — Aadhaar minimisation: last 4 + consent by default, full (encrypted) only by hotel opt-in. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, createPlatformAdmin, db, login, startServer, type Client, type Hotel } from "./helpers";
import { currentStep, totpAt } from "../../src/lib/totp";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;
// Valid Verhoeff test number (not a real person's).
const AADHAAR = "234123412346";

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Aadhaar");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

describe("Aadhaar minimisation", () => {
  it("new hotels keep the last 4 digits only, and saving needs consent", async () => {
    expect((await owner.call("GET", "/admin/aadhaar-settings")).body).toEqual({ mode: "LAST4", fullNumbersStored: 0 });
    expect((await owner.call("PATCH", `/admin/staff/${h.users.cashier.id}/aadhaar`, { aadhaar: AADHAAR })).status).toBe(400);
    const saved = await owner.call("PATCH", `/admin/staff/${h.users.cashier.id}/aadhaar`, { aadhaar: AADHAAR, consent: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ aadhaar: "XXXX-XXXX-2346", fullStored: false, mode: "LAST4" });
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id } });
    expect(u.aadhaarEnc).toBeNull();
    expect(u.aadhaarLast4).toBe("2346");
    expect(u.aadhaarConsentById).toBe(h.users.owner.id);
    expect(u.aadhaarConsentVersion).toMatch(/:LAST4$/);
    // Nothing to reveal.
    const r = await owner.call("GET", `/admin/staff/${h.users.cashier.id}/aadhaar?reveal=1`);
    expect(r.body).toMatchObject({ aadhaar: "XXXX-XXXX-2346", revealed: false, fullStored: false });
  });

  it("a hotel that opts in to FULL stores the number encrypted; reveal is audited", async () => {
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("PATCH", "/admin/aadhaar-settings", { mode: "FULL" })).status).toBe(403);
    expect((await owner.call("PATCH", "/admin/aadhaar-settings", { mode: "FULL" })).status).toBe(200);
    await owner.call("PATCH", `/admin/staff/${h.users.kitchen.id}/aadhaar`, { aadhaar: AADHAAR, consent: true });
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.kitchen.id } });
    expect(u.aadhaarEnc).toBeTruthy();
    expect(u.aadhaarEnc).not.toContain(AADHAAR);
    const r = await owner.call("GET", `/admin/staff/${h.users.kitchen.id}/aadhaar?reveal=1`);
    expect(r.body).toMatchObject({ aadhaar: AADHAAR, revealed: true, fullStored: true });
    expect(await db.auditLog.count({ where: { action: "staff.aadhaar_reveal", entityId: h.users.kitchen.id } })).toBe(1);
  });

  it("switching back to LAST4 keeps stored numbers until the owner reduces them (irreversible)", async () => {
    await owner.call("PATCH", "/admin/aadhaar-settings", { mode: "LAST4" });
    expect((await owner.call("GET", "/admin/aadhaar-settings")).body).toEqual({ mode: "LAST4", fullNumbersStored: 1 });
    expect((await owner.call("POST", "/admin/aadhaar/reduce-to-last4", {})).status).toBe(400);
    expect((await owner.call("POST", "/admin/aadhaar/reduce-to-last4", { confirm: "REDUCE" })).body).toEqual({ reduced: 1 });
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.kitchen.id } });
    expect(u.aadhaarEnc).toBeNull();
    expect(u.aadhaarLast4).toBe("2346");
  });

  it("a record can be deleted", async () => {
    expect((await owner.call("DELETE", `/admin/staff/${h.users.cashier.id}/aadhaar`)).status).toBe(204);
    expect((await owner.call("GET", `/admin/staff/${h.users.cashier.id}/aadhaar`)).body).toMatchObject({ aadhaar: null, consent: null });
  });

  it("a support view never sees Aadhaar", async () => {
    await owner.call("PATCH", `/admin/staff/${h.users.inventory.id}/aadhaar`, { aadhaar: AADHAAR, consent: true });
    await owner.call("POST", "/support-access", { hours: 1 });
    const admin = await login(srv.base, (await createPlatformAdmin()).email);
    const setup = await admin.call("POST", "/auth/2fa/setup");
    await admin.call("POST", "/auth/2fa/enable", { code: totpAt(setup.body.secret, currentStep()) });
    const r = await admin.call("GET", `/admin/staff/${h.users.inventory.id}/aadhaar`, undefined, { "x-support-business": h.businessId, "x-outlet-id": h.outletId });
    expect(r.status).toBe(403);
  });
});
