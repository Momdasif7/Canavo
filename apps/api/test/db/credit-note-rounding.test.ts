/**
 * QA Phase 7 (database) — dba-1: unit-by-unit refunds must never produce a negative tax column on a
 * credit note. Each partial refund rounded its own share (round(v × q / Q)); when the shares round up,
 * the last unit ("whatever is left") went negative — e.g. CGST 20 paise on 8 units refunded one at a
 * time: 7 × round(2.5) = 21, last note CGST = −1 paise. Blocks a CHECK (tax >= 0) on CreditNote.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, manager: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("DB CN rounding", { gst: true });
  manager = await login(srv.base, h.users.manager.email, h.outletId);
});
afterAll(() => srv.close());

it("refunding 8 units one at a time: every credit-note column ≥ 0 and the notes add up to the line", async () => {
  // ₹1.05 incl. 5% GST → taxable 100, CGST 2.5, SGST 2.5 per unit; the line of 8: taxable 800, CGST 20, SGST 20.
  const cat = await db.menuCategory.findFirstOrThrow({ where: { businessId: h.businessId } });
  const gst5 = await db.taxRate.create({ data: { businessId: h.businessId, name: "GST 5% (CN test)", cgst: 2.5, sgst: 2.5, igst: 5 } });
  const tea = await db.menuItem.create({ data: { businessId: h.businessId, categoryId: cat.id, name: "Cutting chai", price: 105, gstRate: 5, taxRateId: gst5.id } });
  const o = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: tea.id, quantity: 8 }] });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const line = o.body.items[0] as { id: string; cgst: number; sgst: number; taxableValue: number; serviceCharge: number; total: number };
  expect(line.cgst % 8).not.toBe(0); // the case that rounds
  expect((await manager.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] })).status).toBe(200);

  for (let i = 0; i < 8; i++) {
    const r = await manager.call("POST", `/orders/${o.body.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", items: [{ orderItemId: line.id, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  const notes = await db.creditNote.findMany({ where: { orderId: o.body.id } });
  expect(notes).toHaveLength(8);
  for (const n of notes) {
    for (const f of ["taxableValue", "cgst", "sgst", "igst", "cess", "otherTaxes", "amount"] as const) expect(n[f], `${n.number}.${f}`).toBeGreaterThanOrEqual(0);
  }
  const sum = (f: "cgst" | "sgst" | "taxableValue") => notes.reduce((s, n) => s + n[f], 0);
  expect(sum("cgst")).toBe(line.cgst);
  expect(sum("sgst")).toBe(line.sgst);
  expect(sum("taxableValue")).toBe(line.taxableValue + line.serviceCharge);
  expect(notes.reduce((s, n) => s + n.amount, 0)).toBe(o.body.grandTotal);
});
