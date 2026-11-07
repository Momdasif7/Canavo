/**
 * QA Phase 6 — /admin: settings, brand, audit log, report schedules, backups, owner export,
 * Aadhaar (masked), WhatsApp config (tokens never returned). Contract, rbac loop,
 * cross-tenant / cross-outlet, validation, pagination.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { allowedRoles, cast, createPlatformAdmin, db, expectAuthz, expectNoSecrets, HUGE, NASTY, signIn, type Cast, type Session } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Cast;
let owner: Session, manager: Session, otherOwner: Session, admin: Session;

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Admin API"), await createHotel("Admin Other")];
  c = await cast(srv.base, h);
  ({ BUSINESS_OWNER: owner, OUTLET_MANAGER: manager } = c.clients);
  otherOwner = await signIn(srv.base, other.users.owner.email, other.outletId);
  admin = await signIn(srv.base, (await createPlatformAdmin()).email);
});
afterAll(() => srv.close());

// A valid (Verhoeff) Aadhaar number used across tests
const AADHAAR = "234123412346";

describe("authorization matrix", () => {
  it.each([
    ["GET", "/admin/report-schedules", ["report:view"]],
    ["POST", "/admin/report-schedules", ["report:view", "settings:outlet"]],
    ["GET", "/admin/audit-logs", ["audit:view"]],
    ["GET", "/admin/settings", ["settings:outlet"]],
    ["PUT", "/admin/brand", ["outlet:manage"]],
    ["GET", "/admin/export", ["data:export"]],
    ["GET", "/admin/aadhaar-settings", ["staff:manage"]],
    ["PATCH", "/admin/aadhaar-settings", ["outlet:manage"]],
    ["POST", "/admin/aadhaar/reduce-to-last4", ["outlet:manage"]],
    // WhatsApp is an integration: owner only since Settings → Integrations (was settings:outlet)
    ["GET", "/admin/whatsapp", ["outlet:manage"]],
    ["PUT", "/admin/whatsapp", ["outlet:manage"]],
    ["POST", "/admin/whatsapp/test", ["outlet:manage"]],
    ["GET", "/admin/backups", ["admin:backup"]],
    ["POST", "/admin/backups", ["admin:backup"]],
    ["GET", "/admin/table-counts", ["admin:backup"]],
    ["GET", "/admin/brand", []],
  ] as const)("%s %s", async (method, path, perms) => {
    const body = method === "GET" ? undefined : method === "PUT" && path === "/admin/brand" ? { accent: "#112233" } : {};
    // export: a tiny request is fine (streams the owner's own data)
    await expectAuthz(c, method, path, allowedRoles([...perms], method), body);
  });

  it("aadhaar per-staff routes need staff:manage", async () => {
    await expectAuthz(c, "GET", `/admin/staff/${c.ids.KITCHEN}/aadhaar`, allowedRoles(["staff:manage"], "GET"));
    await expectAuthz(c, "PATCH", `/admin/staff/${c.ids.KITCHEN}/aadhaar`, allowedRoles(["staff:manage"], "PATCH"), {});
  });

  it("the platform admin: backups and platform settings only — no brand, export, Aadhaar, WhatsApp or hotel schedules", async () => {
    for (const [m, p] of [
      ["GET", "/admin/brand"],
      ["GET", "/admin/export"],
      ["GET", `/admin/staff/${c.ids.CASHIER}/aadhaar`],
      ["GET", "/admin/aadhaar-settings"],
      ["GET", "/admin/whatsapp"],
      ["GET", "/admin/report-schedules"],
      ["GET", `/admin/settings/${h.outletId}/printer.defaults`],
    ] as const) {
      const r = await admin.call(m, p, undefined, { "x-outlet-id": h.outletId, "x-business-id": h.businessId });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect((await admin.call("GET", "/admin/settings/GLOBAL/printer.defaults")).status).toBe(200);
    expect((await admin.call("GET", "/admin/table-counts")).status).toBe(200);
  });
});

describe("settings", () => {
  it("GET /admin/settings: keys + defaults", async () => {
    const r = await manager.call("GET", "/admin/settings");
    expect(r.status).toBe(200);
    expect(r.body.keys).toEqual(expect.arrayContaining(["printer.defaults", "notifications.prefs"]));
  });

  it("outlet scope: manager reads and writes their outlet; other outlet / hotel → 403; unknown outlet → 403", async () => {
    const put = await manager.call("PUT", `/admin/settings/${h.outletId}/printer.defaults`, { value: { paperWidth: 80, printerName: NASTY.tamil } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ scope: h.outletId, key: "printer.defaults", value: { paperWidth: 80, printerName: NASTY.tamil } });
    const get = await manager.call("GET", `/admin/settings/${h.outletId}/printer.defaults`);
    expect(get.body).toMatchObject({ isDefault: false, value: { paperWidth: 80 } });
    expect((await manager.call("PUT", `/admin/settings/${h.outlet2Id}/printer.defaults`, { value: {} })).status).toBe(403);
    expect((await otherOwner.call("PUT", `/admin/settings/${h.outletId}/printer.defaults`, { value: {} })).status).toBe(403);
    expect((await otherOwner.call("GET", `/admin/settings/${h.outletId}/printer.defaults`)).status).toBe(403);
    expect((await owner.call("GET", "/admin/settings/cl0000000000000000000000/printer.defaults")).status).toBe(403);
  });

  it("business scope (GLOBAL = my business): owner only writes; the platform default is untouched", async () => {
    expect((await manager.call("PUT", "/admin/settings/GLOBAL/service.preOrderLeadMinutes", { value: 45 })).status).toBe(403);
    const r = await owner.call("PUT", "/admin/settings/GLOBAL/service.preOrderLeadMinutes", { value: 45 });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe(h.businessId);
    expect(await db.setting.findUnique({ where: { scope_key: { scope: "GLOBAL", key: "service.preOrderLeadMinutes" } } })).toBeNull();
    // another hotel still sees the default
    expect((await otherOwner.call("GET", "/admin/settings/GLOBAL/service.preOrderLeadMinutes")).body).toMatchObject({ value: 30, isDefault: true });
  });

  it("400: unknown key, invalid values (types, extra fields, floats, huge), ipWhitelist super-admin only", async () => {
    expect((await owner.call("GET", "/admin/settings/GLOBAL/evil.key")).status).toBe(400);
    for (const [key, value] of [
      ["printer.defaults", { paperWidth: 72 }],
      ["printer.defaults", { evil: true }],
      ["printer.defaults", { receiptCopies: 1.5 }],
      ["printer.defaults", { printerName: HUGE }],
      ["service.preOrderLeadMinutes", -1],
      ["service.preOrderLeadMinutes", 10.5],
      ["service.preOrderLeadMinutes", "30"],
      ["service.preOrderLeadMinutes", null],
      ["notifications.prefs", { "Bad Key!": { push: true } }],
      ["whatsapp.templates", { receipt: { template: "", language: "en" } }],
    ] as const)
      expect((await owner.call("PUT", `/admin/settings/${h.outletId}/${key}`, { value })).status, `${key} ${JSON.stringify(value).slice(0, 60)}`).toBe(400);
    expect((await owner.call("PUT", "/admin/settings/GLOBAL/security.ipWhitelist", { value: [] })).status).toBe(403);
    expect((await admin.call("PUT", "/admin/settings/GLOBAL/security.ipWhitelist", { value: ["999.1.1.1"] })).status).toBe(400);
  });
});

describe("brand", () => {
  it("PUT: 200; strict body (extra fields / bad colours → 400 and nothing saved); everyone reads it", async () => {
    const r = await owner.call("PUT", "/admin/brand", { accent: "#1a2b3c", corners: "square" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accent: "#1A2B3C", corners: "square" });
    for (const body of [{ accent: "red" }, { accent: NASTY.xss }, { corners: "round" }, { accent: "#123456", businessId: other.businessId }, []])
      expect((await owner.call("PUT", "/admin/brand", body)).status, JSON.stringify(body)).toBe(400);
    expect((await c.clients.DELIVERY.call("GET", "/admin/brand")).body).toEqual({ accent: "#1A2B3C", corners: "square" });
    expect((await otherOwner.call("GET", "/admin/brand")).body.accent).not.toBe("#1A2B3C");
  });
});

describe("audit log", () => {
  it("contract + pagination; 400 on bad page / pageSize / dates (incl. impossible dates)", async () => {
    const r = await owner.call("GET", "/admin/audit-logs?pageSize=2&page=1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page: 1, pageSize: 2, total: expect.any(Number), pages: expect.any(Number), items: expect.any(Array) });
    expect(r.body.items.length).toBeLessThanOrEqual(2);
    expectNoSecrets(r.body);
    const far = await owner.call("GET", "/admin/audit-logs?page=9999");
    expect(far.body.items).toEqual([]);
    for (const q of ["page=0", "page=-1", "pageSize=0", "pageSize=201", "pageSize=abc", "from=bad", "from=2026-13-45", "to=2026-02-30", "from=2026-00-10"])
      expect((await owner.call("GET", `/admin/audit-logs?${q}`)).status, q).toBe(400);
  });

  it("IST day boundaries: an entry at 23:59:59.999 IST is in that day, 00:00 IST the next day is not", async () => {
    const base = { businessId: h.businessId, outletId: h.outletId, userId: c.ids.BUSINESS_OWNER, entity: "QA", entityId: "x" };
    // 2026-03-10 23:59:59.999 IST = 18:29:59.999Z; 2026-03-11 00:00 IST = 18:30Z
    await db.auditLog.create({ data: { ...base, action: "qa.edge.last", createdAt: new Date("2026-03-10T18:29:59.999Z") } });
    await db.auditLog.create({ data: { ...base, action: "qa.edge.next", createdAt: new Date("2026-03-10T18:30:00.000Z") } });
    await db.auditLog.create({ data: { ...base, action: "qa.edge.first", createdAt: new Date("2026-03-09T18:30:00.000Z") } });
    const day = await owner.call("GET", "/admin/audit-logs?action=qa.edge.*&from=2026-03-10&to=2026-03-10");
    expect(day.body.items.map((i: { action: string }) => i.action).sort()).toEqual(["qa.edge.first", "qa.edge.last"]);
    const empty = await owner.call("GET", "/admin/audit-logs?action=qa.edge.*&from=2026-03-12&to=2026-03-01");
    expect(empty.body.items).toEqual([]);
  });

  it("scoping: owner sees business-wide entries; manager only own outlets; other hotels and the platform admin see none", async () => {
    const base = { businessId: h.businessId, userId: c.ids.BUSINESS_OWNER, entity: "QA", entityId: "y" };
    await db.auditLog.create({ data: { ...base, action: "qa.scope.biz" } });
    await db.auditLog.create({ data: { ...base, action: "qa.scope.o2", outletId: h.outlet2Id } });
    const actions = async (s: Session, q = "") => (await s.call("GET", `/admin/audit-logs?action=qa.scope.*${q}`)).body.items.map((i: { action: string }) => i.action).sort();
    expect(await actions(owner)).toEqual(["qa.scope.biz", "qa.scope.o2"]);
    expect(await actions(manager)).toEqual([]);
    expect(await actions(manager, `&outletId=${h.outlet2Id}`)).toEqual([]);
    expect(await actions(otherOwner)).toEqual([]);
    expect(await actions(admin)).toEqual([]);
    expect(await actions(c.clients.AUDITOR)).toEqual([]);
  });
});

describe("report schedules", () => {
  it("201 contract; 400 on bad input; delete/send-now 404 for unknown or another hotel's", async () => {
    const r = await manager.call("POST", "/admin/report-schedules", { email: "owner@hotel.in", frequency: "DAILY", reports: ["sales"], outletId: h.outlet2Id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outletId: h.outletId, active: true, frequency: "DAILY" });
    for (const body of [{}, { email: "nope", frequency: "DAILY", reports: ["sales"] }, { email: "a@b.in", frequency: "HOURLY", reports: ["sales"] }, { email: "a@b.in", frequency: "DAILY", reports: [] }, { email: "a@b.in", frequency: "DAILY", reports: ["salary"] }])
      expect((await manager.call("POST", "/admin/report-schedules", body)).status, JSON.stringify(body)).toBe(400);
    expect((await otherOwner.call("DELETE", `/admin/report-schedules/${r.body.id}`)).status).toBe(404);
    expect((await otherOwner.call("POST", `/admin/report-schedules/${r.body.id}/send-now`)).status).toBe(404);
    expect((await manager.call("DELETE", "/admin/report-schedules/cl0000000000000000000000")).status).toBe(404);
    expect((await manager.call("GET", "/admin/report-schedules")).body.map((s: { id: string }) => s.id)).toContain(r.body.id);
    expect((await otherOwner.call("GET", "/admin/report-schedules")).body.map((s: { id: string }) => s.id)).not.toContain(r.body.id);
    expect((await manager.call("DELETE", `/admin/report-schedules/${r.body.id}`)).status).toBe(204);
  });

  it("module REPORTS off → refused", async () => {
    const off = await createHotel("No reports", { modules: ["BILLING"] });
    const o = await signIn(srv.base, off.users.owner.email, off.outletId);
    expect((await o.call("GET", "/admin/report-schedules")).status).toBe(403);
  });
});

describe("Aadhaar", () => {
  it("PATCH: masked response; consent required; invalid numbers 400; GET masked (XXXX-XXXX-last4)", async () => {
    const r = await owner.call("PATCH", `/admin/staff/${c.ids.KITCHEN}/aadhaar`, { aadhaar: AADHAAR, consent: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(AADHAAR);
    expect(r.body.aadhaar).toMatch(/2346$/);
    for (const body of [{ aadhaar: AADHAAR }, { aadhaar: AADHAAR, consent: false }, { aadhaar: "123412341234", consent: true }, { aadhaar: "23412341234", consent: true }, { aadhaar: "234123412345", consent: true }, { aadhaar: 234123412346, consent: true }])
      expect((await owner.call("PATCH", `/admin/staff/${c.ids.KITCHEN}/aadhaar`, body)).status, JSON.stringify(body)).toBe(400);
    const g = await manager.call("GET", `/admin/staff/${c.ids.KITCHEN}/aadhaar`);
    expect(g.status).toBe(200);
    expect(g.body.aadhaar).toBe("XXXX-XXXX-2346");
    // LAST4 mode: reveal can't show what isn't stored
    const rv = await owner.call("GET", `/admin/staff/${c.ids.KITCHEN}/aadhaar?reveal=1`);
    expect(rv.body.aadhaar).toBe("XXXX-XXXX-2346");
    // not in staff list / me
    expect(JSON.stringify((await owner.call("GET", "/staff")).body)).not.toMatch(/2346|aadhaar/i);
  });

  it("scope: manager can't see the owner's or another manager's; other hotel 404; unknown 404", async () => {
    expect((await manager.call("GET", `/admin/staff/${c.ids.BUSINESS_OWNER}/aadhaar`)).status).toBe(404);
    expect((await otherOwner.call("GET", `/admin/staff/${c.ids.KITCHEN}/aadhaar`)).status).toBe(404);
    expect((await otherOwner.call("PATCH", `/admin/staff/${c.ids.KITCHEN}/aadhaar`, { aadhaar: AADHAAR, consent: true })).status).toBe(404);
    expect((await owner.call("GET", "/admin/staff/cl0000000000000000000000/aadhaar")).status).toBe(404);
  });

  it("settings: mode enum 400; reduce needs the literal confirm", async () => {
    expect((await owner.call("PATCH", "/admin/aadhaar-settings", { mode: "HALF" })).status).toBe(400);
    expect((await owner.call("POST", "/admin/aadhaar/reduce-to-last4", { confirm: "yes" })).status).toBe(400);
    const s = await owner.call("GET", "/admin/aadhaar-settings");
    expect(s.body).toEqual({ mode: "LAST4", fullNumbersStored: 0 });
  });
});

describe("WhatsApp config", () => {
  it("PUT stores tokens encrypted; GET never returns them (masked to the last 4)", async () => {
    const token = "EAAG-super-secret-token-1234567890ABCD";
    const r = await owner.call("PUT", "/admin/whatsapp", { provider: "META", meta: { phoneNumberId: "1234567890", accessToken: token } });
    expect(r.status).toBe(200);
    const g = await owner.call("GET", "/admin/whatsapp");
    expect((await manager.call("GET", "/admin/whatsapp")).status).toBe(403);
    expect(g.status).toBe(200);
    expect(JSON.stringify(g.body)).not.toContain(token);
    expect(JSON.stringify(g.body)).not.toMatch(/accessTokenEnc|tokenEnc/);
    expect(g.body.meta.token).toBe("••••ABCD");
    const row = await db.setting.findFirstOrThrow({ where: { scope: h.businessId, key: { contains: "whatsapp" } } });
    expect(JSON.stringify(row.value)).not.toContain(token);
    expect((await otherOwner.call("GET", "/admin/whatsapp")).body.meta).toBeNull();
  });

  it("400 on bad configs", async () => {
    for (const body of [{}, { provider: "SMS" }, { provider: "META" }, { provider: "META", meta: { phoneNumberId: "abc" } }, { provider: "WATI", wati: { apiUrl: "http://insecure.example", token: "x".repeat(20) } }, { provider: "NONE", templates: { receipt: HUGE } }])
      expect((await owner.call("PUT", "/admin/whatsapp", body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect((await owner.call("POST", "/admin/whatsapp/test", { phone: "12345" })).status).toBe(400);
  });
});

describe("owner data export", () => {
  it("only this hotel's rows; no password/PIN hashes or encrypted Aadhaar", async () => {
    await db.user.update({ where: { id: c.ids.CASHIER }, data: { pinHash: "$2a$04$abcdefghijklmnopqrstuuJ0123456789012345678901234567" } });
    const r = await owner.call("GET", "/admin/export?format=json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="canavo-export-/);
    const text = JSON.stringify(r.body);
    for (const leak of [other.businessId, other.outletId, other.users.owner.id, "$2a$", "passwordHash", "pinHash", "aadhaarEnc", "totpSecretEnc"]) expect(text, leak).not.toContain(leak);
    expect(text).toContain(h.businessId);
    expect((await owner.call("GET", "/admin/export?format=pdf")).status).toBe(400);
  });
});

describe("backups (platform)", () => {
  it("restore: confirm literal required; bad / traversal names 400; unknown file 404", async () => {
    expect((await admin.call("POST", "/admin/backups/canavo-backup-manual-20260101-000000.ndjson.gz/restore", {})).status).toBe(400);
    for (const f of ["..%2F..%2Fetc%2Fpasswd", "evil.gz", "canavo-backup-manual-20260101-000000.ndjson.gz.sh"])
      expect((await admin.call("POST", `/admin/backups/${f}/restore`, { confirm: "RESTORE" })).status, f).toBe(400);
    expect((await admin.call("POST", "/admin/backups/canavo-backup-manual-20200101-000000.ndjson.gz/restore", { confirm: "RESTORE" })).status).toBe(404);
  });

  it("list is an array; owners can't list, create or restore", async () => {
    const r = await admin.call("GET", "/admin/backups");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((await owner.call("POST", "/admin/backups/canavo-backup-manual-20200101-000000.ndjson.gz/restore", { confirm: "RESTORE" })).status).toBe(403);
  });
});
