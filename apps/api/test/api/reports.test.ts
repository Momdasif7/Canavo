/**
 * QA Phase 6 — /reports: every report endpoint (12 range reports, GSTR-1, daily, outlets overview,
 * owner summary). RBAC for every role, module gating, isolation, all-outlets views scoped to the
 * caller's outlets, IST day boundaries, invalid / reversed / huge ranges, Excel + PDF exports
 * (content type, magic bytes) and formula-injection escaping in Excel cells.
 */
import ExcelJS from "exceljs";
import { REPORT_KEYS } from "@canavo/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer } from "../integration/helpers";
import { db, intMoney, login, raw, rbacMatrix, rejectsQuery, world, type Ep, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
const owner = () => w.as.BUSINESS_OWNER;
const EVIL = "=HYPERLINK(\"http://evil.example\",\"Click\")";
let evilItem: string;

async function paidOrder(menuItemId: string, at?: Date) {
  const o = await owner().call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId, quantity: 1 }] });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const p = await owner().call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  if (at) {
    await db.order.update({ where: { id: o.body.id }, data: { createdAt: at, paidAt: at } });
    await db.payment.updateMany({ where: { orderId: o.body.id }, data: { createdAt: at } });
  }
  return o.body as { id: string; grandTotal: number };
}

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "Reports API", ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS", "CANTEEN"]);
  const cat = await db.menuCategory.findFirstOrThrow({ where: { businessId: w.h.businessId } });
  evilItem = (await db.menuItem.create({ data: { businessId: w.h.businessId, categoryId: cat.id, name: EVIL, price: 1000 } })).id;
  await paidOrder(evilItem);
  await paidOrder(w.h.items.samosa);
}, 60_000);
afterAll(() => srv.close());

describe("RBAC + isolation", () => {
  it("report:view on every report endpoint, for every role", async () => {
    const eps: Ep[] = [
      ...REPORT_KEYS.map((k) => ({ method: "GET" as const, path: `/reports/${k}`, perms: ["report:view" as const] })),
      { method: "GET", path: "/reports/gstr1?month=2026-10", perms: ["report:view"] },
      { method: "GET", path: "/reports/daily", perms: ["report:view"] },
      { method: "GET", path: "/reports/outlets/overview", perms: ["report:view"] },
      { method: "GET", path: "/reports/owner-summary", perms: ["report:view"] },
    ];
    expect(eps).toHaveLength(16);
    await rbacMatrix(w, eps);
  });

  it("another hotel / unassigned outlet / super admin: refused on every report, no figures", async () => {
    const paths = [...REPORT_KEYS.map((k) => `/reports/${k}`), "/reports/gstr1?month=2026-10", "/reports/daily"];
    const theirsInMine = await login(srv.base, w.other.h.users.owner.email, w.h.outletId);
    const wrong: string[] = [];
    for (const p of paths) {
      for (const [who, c] of [["other owner w/ my outlet", theirsInMine], ["manager @ outlet 2", w.managerAtOutlet2], ["super admin", w.admin]] as const) {
        const r = await c.call("GET", p);
        // The super admin has no outlet at all (400 "X-Outlet-Id required"); with one it would be 403
        if (r.status !== 403 && !(who === "super admin" && r.status === 400)) wrong.push(`${who} ${p} → ${r.status}`);
        if (r.status < 400) wrong.push(`${who} ${p} got data`);
      }
    }
    for (const k of ["sales", "daily"]) {
      const r = await fetch(`${srv.base}/reports/${k}`, { headers: { authorization: `Bearer ${w.admin.token}`, "x-outlet-id": w.h.outletId } });
      if (r.status !== 403) wrong.push(`super admin with x-outlet-id /reports/${k} → ${r.status}`);
    }
    for (const p of ["/reports/outlets/overview", "/reports/owner-summary"]) {
      const r = await w.admin.call("GET", p);
      if (r.status !== 403) wrong.push(`super admin ${p} → ${r.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("all-outlets views list only the caller's outlets: owner both, manager / accountant only outlet 1, other hotel none of mine", async () => {
    const ids = async (c: typeof w.as.BUSINESS_OWNER) => {
      const o = await c.call("GET", "/reports/outlets/overview");
      const s = await c.call("GET", "/reports/owner-summary");
      expect(o.status).toBe(200);
      expect(s.status).toBe(200);
      return { overview: o.body.outlets.map((x: { outletId: string }) => x.outletId).sort(), summary: s.body.outlets.map((x: { outletId: string }) => x.outletId).sort() };
    };
    const both = [w.h.outletId, w.h.outlet2Id].sort();
    expect(await ids(owner())).toEqual({ overview: both, summary: both });
    expect(await ids(w.as.OUTLET_MANAGER)).toEqual({ overview: [w.h.outletId], summary: [w.h.outletId] });
    expect(await ids(w.as.ACCOUNTANT)).toEqual({ overview: [w.h.outletId], summary: [w.h.outletId] });
    const theirs = await ids(w.other.owner);
    expect(theirs.overview).not.toContain(w.h.outletId);
    const ov = (await owner().call("GET", "/reports/outlets/overview")).body;
    intMoney(ov.totals, ["gross", "aov", "openBillsValue"]);
    expect(ov.totals.orders).toBeGreaterThanOrEqual(2);
  });

  it("module REPORTS off → 403", async () => {
    const off = await createHotel("No reports", { modules: ["BILLING"] });
    const c = await login(srv.base, off.users.owner.email, off.outletId);
    for (const p of ["/reports/sales", "/reports/daily", "/reports/outlets/overview", "/reports/gstr1?month=2026-10"]) expect((await c.call("GET", p)).status, p).toBe(403);
  });
});

describe("every report: JSON, Excel, PDF", () => {
  it("JSON 200 for every report key; money totals are integer paise", async () => {
    for (const k of REPORT_KEYS) {
      const r = await w.as.ACCOUNTANT.call("GET", `/reports/${k}`);
      expect(r.status, `${k} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      const t = r.body.totals as Record<string, unknown> | undefined;
      if (t) for (const key of ["gross", "net", "tax", "discounts", "revenue", "taxable"]) if (key in t) intMoney(t, [key]);
    }
    const sales = await owner().call("GET", "/reports/sales");
    expect(sales.body.totals.orders).toBeGreaterThanOrEqual(2);
  });

  it("xlsx and pdf: content type, attachment filename, real file bytes", async () => {
    const paths = [...REPORT_KEYS.map((k) => `/reports/${k}`), "/reports/daily", "/reports/outlets/overview"];
    for (const p of paths) {
      for (const [fmt, type, magic] of [["xlsx", "spreadsheetml", "PK"], ["pdf", "application/pdf", "%PDF"]] as const) {
        const r = await raw(srv.base, owner(), `${p}?format=${fmt}`, w.h.outletId);
        expect(r.status, `${p} ${fmt}`).toBe(200);
        expect(r.headers.get("content-type"), `${p} ${fmt}`).toContain(type);
        expect(r.headers.get("content-disposition"), p).toMatch(new RegExp(`attachment; filename=".+\\.${fmt}"`));
        expect(Buffer.from(await r.arrayBuffer()).subarray(0, magic.length).toString(), `${p} ${fmt}`).toBe(magic);
      }
    }
    const g = await raw(srv.base, owner(), "/reports/gstr1?month=2026-10&format=xlsx", w.h.outletId);
    expect(g.headers.get("content-type")).toContain("spreadsheetml");
    const gj = await raw(srv.base, owner(), "/reports/gstr1?month=2026-10&download=1", w.h.outletId);
    expect(gj.headers.get("content-type")).toContain("application/json");
    expect(gj.headers.get("content-disposition")).toMatch(/GSTR1_.+_102026\.json/);
  });

  it("Excel cells never start with = + - @ (item names typed by staff are escaped, not formulas)", async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    for (const p of [`/reports/items?from=${today}&to=${today}`, `/reports/daily?date=${today}`]) {
      const r = await raw(srv.base, owner(), `${p}&format=xlsx`, w.h.outletId);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await r.arrayBuffer());
      const texts: string[] = [];
      wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => {
        expect(c.formula, p).toBeUndefined();
        if (typeof c.value === "string") texts.push(c.value);
      })));
      expect(texts, p).toContain(`'${EVIL}`);
      expect(texts.filter((t) => /^[=+\-@]/.test(t)), p).toEqual([]);
    }
    // JSON keeps the name verbatim (inert text)
    const j = await owner().call("GET", "/reports/items");
    expect(JSON.stringify(j.body)).toContain("HYPERLINK");
  });
});

describe("date ranges", () => {
  it("IST boundaries: 23:59:59.999 belongs to that day, 00:00:00.000 to the next", async () => {
    const h = await createHotel("IST edges");
    const o = await login(srv.base, h.users.owner.email, h.outletId);
    const mk = async (iso: string) => {
      const ord = await o.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
      await o.call("POST", `/orders/${ord.body.id}/payments`, { payments: [{ mode: "CASH", amount: ord.body.grandTotal }] });
      await db.order.update({ where: { id: ord.body.id }, data: { createdAt: new Date(iso), paidAt: new Date(iso) } });
    };
    await mk("2026-10-14T18:30:00.000Z"); // 15 Oct 00:00:00.000 IST
    await mk("2026-10-15T18:29:59.999Z"); // 15 Oct 23:59:59.999 IST
    await mk("2026-10-15T18:30:00.000Z"); // 16 Oct 00:00:00.000 IST
    const orders = async (q: string) => (await o.call("GET", `/reports/sales?${q}`)).body.totals.orders;
    expect(await orders("from=2026-10-15&to=2026-10-15")).toBe(2);
    expect(await orders("from=2026-10-16&to=2026-10-16")).toBe(1);
    expect(await orders("from=2026-10-14&to=2026-10-14")).toBe(0);
    expect(await orders("from=2026-10-14&to=2026-10-16")).toBe(3);
    expect((await o.call("GET", "/reports/daily?date=2026-10-15")).body.orders).toBe(2);
    expect((await o.call("GET", "/reports/daily?date=2026-10-16")).body).toMatchObject({ orders: 1, comparison: { yesterday: { orders: 2 } } });
    expect((await o.call("GET", "/reports/outlets/overview?date=2026-10-16")).body.totals.orders).toBe(1);
    const hours = (await o.call("GET", "/reports/daily?date=2026-10-15")).body.hourly;
    expect(hours[0].orders).toBe(1);
    expect(hours[23].orders).toBe(1);
  });

  it("qac-7: impossible calendar dates, reversed, malformed and > 366-day ranges → 400 on every endpoint", async () => {
    const bad = ["from=2026-02-30&to=2026-03-01", "from=2026-13-01&to=2026-13-02", "from=2026-10-10&to=2026-10-01", "from=2025-01-01&to=2026-12-31", "from=10-10-2026", "to=2026-1-1", "format=csv", "from=0000-01-01&to=0000-01-02"];
    for (const k of REPORT_KEYS) await rejectsQuery(owner(), `/reports/${k}`, bad);
    await rejectsQuery(owner(), "/reports/daily", ["date=2026-02-31", "date=2026-99-99", "date=yesterday", "format=docx"]);
    await rejectsQuery(owner(), "/reports/outlets/overview", ["date=2026-02-31", "date=2026-99-99", "format=csv"]);
    await rejectsQuery(owner(), "/reports/gstr1", ["", "month=2026-13", "month=2026-1", "month=26-10", "month=2026-10&format=csv", "month=2026-10&download=2"]);
  });

  it("the largest allowed range (366 days) works and is quick; empty periods are zeros", async () => {
    const t0 = Date.now();
    const r = await owner().call("GET", "/reports/sales?from=2025-11-03&to=2026-11-03&groupBy=month");
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const empty = await owner().call("GET", "/reports/sales?from=2020-01-01&to=2020-01-07");
    expect(empty.body.totals).toMatchObject({ orders: 0, gross: 0 });
  });
});
