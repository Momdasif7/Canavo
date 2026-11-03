/**
 * Reports vs raw SQL on the 30-day seed (Phase 5, brief: "every report vs raw
 * SQL sums on the 30-day seed"). The SQL below is an independent oracle written
 * from the report definitions (PAID = sales, CANCELLED tracked separately,
 * OPEN excluded, IST business days) — not a copy of the report code.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, demoTenant, loginAs } from "./helpers";

const TZ = "Asia/Kolkata";
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const today = ymd(new Date());
const from = ymd(new Date(Date.now() - 29 * 86_400_000));
const n = (v: unknown) => Number(v ?? 0);

let outletId: string;
let mgr: Awaited<ReturnType<typeof loginAs>>;

/** [from 00:00 IST, to+1 00:00 IST) as SQL predicate on "createdAt" (stored as UTC timestamp). */
const WINDOW = `"outletId" = $1 AND ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date`;

beforeAll(async () => {
  outletId = (await demoTenant()).outlet.id;
  mgr = await loginAs("manager@canavo.local", outletId);
  const count = await db.order.count({ where: { outletId } });
  expect(count).toBeGreaterThan(1000); // the 30-day seed is present
});

describe("@critical @regression reports reconcile with raw SQL (IT-REP)", () => {
  it("IT-REP-001 sales totals: orders, gross, tax, net, round-off, cancelled count/value", async () => {
    const res = await mgr.get(`/reports/sales?from=${from}&to=${today}`);
    expect(res.status).toBe(200);
    const [sql] = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT count(*) FILTER (WHERE status='PAID') paid, coalesce(sum("grandTotal") FILTER (WHERE status='PAID'),0) gross,
              coalesce(sum(cgst+sgst+igst+cess+"otherTaxes") FILTER (WHERE status='PAID'),0) tax,
              coalesce(sum("roundOff") FILTER (WHERE status='PAID'),0) ro,
              count(*) FILTER (WHERE status='CANCELLED') canc, coalesce(sum("grandTotal") FILTER (WHERE status='CANCELLED'),0) cancv
         FROM "Order" WHERE ${WINDOW}`, outletId, from, today);
    const t = res.body.totals;
    expect(t.orders).toBe(n(sql.paid));
    expect(t.gross).toBe(n(sql.gross));
    expect(t.tax).toBe(n(sql.tax));
    expect(t.roundOff).toBe(n(sql.ro));
    expect(t.net).toBe(n(sql.gross) - n(sql.tax) - n(sql.ro));
    expect(t.cancelled).toBe(n(sql.canc));
    expect(t.cancelledValue).toBe(n(sql.cancv));
  });

  it("IT-REP-002 daily buckets follow IST calendar days", async () => {
    const res = await mgr.get(`/reports/sales?from=${from}&to=${today}&groupBy=day`);
    const rows = await db.$queryRawUnsafe<{ d: Date; gross: unknown; c: unknown }[]>(
      `SELECT ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date d, sum("grandTotal") gross, count(*) c
         FROM "Order" WHERE ${WINDOW} AND status='PAID' GROUP BY 1`, outletId, from, today);
    const byDay = new Map(rows.map((r) => [r.d.toISOString().slice(0, 10), r]));
    expect(res.body.periods).toHaveLength(30);
    for (const p of res.body.periods) {
      const r = byDay.get(p.period);
      expect([p.period, p.gross, p.orders]).toEqual([p.period, n(r?.gross), n(r?.c)]);
    }
  });

  it("IT-REP-003 payment modes equal successful payments on PAID bills", async () => {
    const res = await mgr.get(`/reports/sales?from=${from}&to=${today}`);
    const rows = await db.$queryRawUnsafe<{ mode: string; amt: unknown; c: unknown }[]>(
      `SELECT p.mode, sum(p.amount) amt, count(*) c FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
        WHERE o."outletId" = $1 AND (o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
          AND o.status='PAID' AND p.status='SUCCESS' GROUP BY 1`, outletId, from, today);
    const got = Object.fromEntries((res.body.byPaymentMode as { mode: string; amount: number; count: number }[]).map((m) => [m.mode, [m.amount, m.count]]));
    expect(got).toEqual(Object.fromEntries(rows.map((r) => [r.mode, [n(r.amt), n(r.c)]])));
  });

  it("IT-REP-004 ledger reconciliation: every PAID bill's successful payments sum exactly to its grand total", async () => {
    const bad = await db.$queryRawUnsafe<{ inv: string; total: number; paid: unknown }[]>(
      `SELECT o."invoiceNumber" inv, o."grandTotal" total, coalesce(sum(p.amount) FILTER (WHERE p.status='SUCCESS'),0) paid
         FROM "Order" o LEFT JOIN "Payment" p ON p."orderId" = o.id
        WHERE o."outletId" = $1 AND o.status='PAID' GROUP BY o.id HAVING coalesce(sum(p.amount) FILTER (WHERE p.status='SUCCESS'),0) <> o."grandTotal"`, outletId);
    expect(bad.map((b) => `${b.inv}: total ${b.total} paid ${n(b.paid)}`)).toEqual([]);
  });

  it("IT-REP-005 GST report: document counts by type/status and tax totals of PAID tax invoices", async () => {
    const res = await mgr.get(`/reports/gst?from=${from}&to=${today}`);
    expect(res.status).toBe(200);
    const docs = await db.$queryRawUnsafe<{ t: string; issued: unknown; paid: unknown; open: unknown; canc: unknown }[]>(
      `SELECT "documentType" t, count(*) issued, count(*) FILTER (WHERE status='PAID') paid, count(*) FILTER (WHERE status='OPEN') open,
              count(*) FILTER (WHERE status='CANCELLED') canc FROM "Order" WHERE ${WINDOW} GROUP BY 1`, outletId, from, today);
    for (const d of docs) {
      const r = (res.body.documentTypes as { documentType: string; issued: number; paid: number; open: number; cancelled: number }[]).find((x) => x.documentType === d.t)!;
      expect([r.issued, r.paid, r.open, r.cancelled]).toEqual([n(d.issued), n(d.paid), n(d.open), n(d.canc)]);
    }
    const [tax] = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT coalesce(sum(cgst),0) cgst, coalesce(sum(sgst),0) sgst, coalesce(sum(igst),0) igst, coalesce(sum(cess),0) cess
         FROM "Order" WHERE ${WINDOW} AND status='PAID' AND "documentType"='TAX_INVOICE'`, outletId, from, today);
    const t = res.body.totals;
    expect([t.cgst, t.sgst, t.igst, t.cess]).toEqual([n(tax.cgst), n(tax.sgst), n(tax.igst), n(tax.cess)]);
  });

  it("IT-REP-006 items report: quantity and revenue per item equal OrderItem sums on PAID bills", async () => {
    const res = await mgr.get(`/reports/items?from=${from}&to=${today}&limit=100`);
    const rows = await db.$queryRawUnsafe<{ id: string; q: unknown; rev: unknown }[]>(
      `SELECT i."menuItemId" id, sum(i.quantity) q, sum(i.total) rev FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
        WHERE o."outletId" = $1 AND (o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date
          AND o.status='PAID' GROUP BY 1`, outletId, from, today);
    const items = new Map((res.body.items as { menuItemId: string; quantity: number; revenue: number }[]).map((i) => [i.menuItemId, i]));
    for (const r of rows) expect([items.get(r.id)?.quantity, items.get(r.id)?.revenue], r.id).toEqual([n(r.q), n(r.rev)]);
    expect(res.body.totalRevenue).toBe(rows.reduce((s, r) => s + n(r.rev), 0));
  });

  it("IT-REP-007 daily summary for a busy seed day equals SQL", async () => {
    const [busy] = await db.$queryRawUnsafe<{ d: Date }[]>(
      `SELECT ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date d FROM "Order" WHERE ${WINDOW} AND status='PAID' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      outletId, from, today);
    const day = busy.d.toISOString().slice(0, 10);
    const res = await mgr.get(`/reports/daily?date=${day}`);
    expect(res.status).toBe(200);
    const [sql] = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT count(*) c, sum("grandTotal") g FROM "Order" WHERE ${WINDOW} AND status='PAID'`, outletId, day, day);
    const body = JSON.stringify(res.body);
    expect(body).toContain(String(n(sql.g)));
    expect(body).toContain(String(n(sql.c)));
  });

  it("IT-REP-008 IST day boundary: 23:59:59 IST and 00:00:00 IST land on different days", async () => {
    const cashier = await loginAs("cashier@canavo.local", outletId);
    const item = await db.menuItem.findFirstOrThrow({ where: { status: "AVAILABLE", variants: { none: {} }, availableFrom: null, category: { businessId: (await demoTenant()).businessId } } });
    const mk = async (utcIso: string) => {
      const o = await cashier.post("/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: item.id, quantity: 1 }] });
      await cashier.post(`/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
      await db.order.update({ where: { id: o.body.id }, data: { createdAt: new Date(utcIso) } });
      return o.body.grandTotal as number;
    };
    // 2026-10-10 23:59:59 IST = 18:29:59Z ; 2026-10-11 00:00:00 IST = 18:30:00Z — a range outside the seed window
    const a = await mk("2026-10-10T18:29:59.000Z");
    const b = await mk("2026-10-10T18:30:00.000Z");
    const d10 = await mgr.get(`/reports/sales?from=2026-10-10&to=2026-10-10`);
    const d11 = await mgr.get(`/reports/sales?from=2026-10-11&to=2026-10-11`);
    const sql = async (d: string) => n((await db.$queryRawUnsafe<{ g: unknown }[]>(`SELECT sum("grandTotal") g FROM "Order" WHERE ${WINDOW} AND status='PAID'`, outletId, d, d))[0].g);
    expect(d10.body.totals.gross).toBe(await sql("2026-10-10"));
    expect(d11.body.totals.gross).toBe(await sql("2026-10-11"));
    expect(d10.body.totals.gross).toBeGreaterThanOrEqual(a);
    expect(d11.body.totals.gross).toBeGreaterThanOrEqual(b);
  });

  it("IT-REP-009 every report key loads for the manager over 30 days, and exports as xlsx and pdf", async () => {
    for (const key of ["sales", "items", "categories", "peak-hours", "gst", "profit", "staff", "customers", "inventory", "delivery"]) {
      const j = await mgr.get(`/reports/${key}?from=${from}&to=${today}`);
      expect(j.status, key).toBe(200);
    }
    const x = await mgr.get(`/reports/sales?from=${from}&to=${today}&format=xlsx`);
    expect(x.headers["content-type"]).toMatch(/spreadsheetml/);
    const p = await mgr.get(`/reports/gst?from=${from}&to=${today}&format=pdf`);
    expect(p.headers["content-type"]).toMatch(/pdf/);
  });

  it("IT-REP-010 range validation: from > to → 400, 367 days → 400, 366 days → 200, bad date → 400", async () => {
    expect((await mgr.get(`/reports/sales?from=2026-10-10&to=2026-10-01`)).status).toBe(400);
    expect((await mgr.get(`/reports/sales?from=2025-01-01&to=2026-01-02`)).status).toBe(400);
    expect((await mgr.get(`/reports/sales?from=2025-01-01&to=2026-01-01`)).status).toBe(200);
    expect((await mgr.get(`/reports/sales?from=2026-13-01&to=2026-13-02`)).status).toBe(400);
  });
});
