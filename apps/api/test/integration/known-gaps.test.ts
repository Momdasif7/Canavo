/**
 * QA Phase 16b — known gaps from the spec (docs/qa/known-gaps.md).
 *  - gap 2: B2B / B2CL / CDNR / CDNUR in GSTR-1 (buyer GSTIN + place of supply on bills)
 *  - gap 5: coupons are pre-tax discounts per line; gift cards are a payment, not a discount
 *  - gap 8: platform archive / restore of a business
 *  - gap 3 (P2, built): background location batches — duty / outlet-setting / run gating, validation + throttling, no history
 *  - gap 7 (P2, built): clock-in face check — DPDP consent + version, reference photo, review queue, never blocks, retention
 *  - P2 gaps awaiting approval: it.skip with the reason
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gstinCheckChar } from "@canavo/shared";
import { createHotel, createPlatformAdmin, db, login, PASSWORD, startServer, type Client, type Hotel } from "./helpers";
import { businessRetentionEnd } from "../../src/routes/platform";
import { FACE_CONSENT_VERSION } from "@canavo/shared";
import { purgeOldSelfies } from "../../src/services/face-check";
import { resetTracking } from "../../src/services/delivery-track";

const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const OWN = gstin("33AAAAA1111A1Z"); // the outlet (Tamil Nadu, 33)
const BUYER = gstin("29BBBBB2222B1Z"); // a Karnataka company eating in Chennai
const BUYER2 = gstin("33CCCCC3333C1Z");

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;
const month = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Gaps", { gst: true });
  await db.outlet.update({ where: { id: h.outletId }, data: { gstin: OWN } });
  const gst5 = await db.taxRate.findFirstOrThrow({ where: { businessId: h.businessId, cgst: 2.5, sgst: 2.5 } });
  await db.menuItem.updateMany({ where: { id: { in: Object.values(h.items) } }, data: { taxRateId: gst5.id } });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

const order = (body: object, qty = 1) =>
  owner.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: qty }], ...body });
const payCash = async (o: { id: string; grandTotal: number }) => {
  const r = await owner.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] });
  expect(r.status).toBe(200);
};

describe("gap 2 — B2B invoices and GSTR-1 B2B / B2CL / CDNR / CDNUR", () => {
  it("refuses a bad B2B buyer: invalid GSTIN, no legal name, the outlet's own GSTIN, IGST with a same-state place of supply", async () => {
    expect((await order({ buyerGstin: "29BBBBB2222B1ZX", buyerName: "Acme" })).status).toBe(400);
    expect((await order({ buyerGstin: BUYER })).body.error).toMatch(/legal name/);
    expect((await order({ buyerGstin: OWN, buyerName: "Self" })).body.error).toMatch(/own GSTIN/);
    expect((await order({ interState: true, placeOfSupply: "33" })).body.error).toMatch(/outside the outlet's state/);
  });

  it("a non-GST outlet can't issue a B2B invoice", async () => {
    const plain = await createHotel("GapsPlain", { gst: false });
    const o = await login(srv.base, plain.users.owner.email, plain.outletId);
    const r = await o.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: plain.items.chai, quantity: 1 }], buyerGstin: BUYER, buyerName: "Acme" });
    expect(r.status).toBe(400);
  });

  it("B2B bill: buyer stored and printed; restaurant service stays intra-state (POS = outlet) even for an out-of-state buyer", async () => {
    const r = await order({ buyerGstin: BUYER.toLowerCase(), buyerName: "Acme Foods Pvt Ltd", buyerAddress: "MG Road, Bengaluru" });
    expect(r.status).toBe(201);
    const row = await db.order.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row).toMatchObject({ buyerGstin: BUYER, buyerName: "Acme Foods Pvt Ltd", interState: false, placeOfSupply: null, igst: 0 });
    expect(row.cgst).toBeGreaterThan(0);
    const receipt = (await owner.call("GET", `/orders/${r.body.id}/receipt`)).body;
    expect(receipt.data?.buyer ?? receipt.buyer).toMatchObject({ gstin: BUYER, name: "Acme Foods Pvt Ltd" });
    await payCash(r.body);
  });

  it("a place of supply in another state makes the bill inter-state (IGST) and is printed", async () => {
    const r = await order({ placeOfSupply: "29" }, 10);
    expect(r.status).toBe(201);
    const row = await db.order.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row).toMatchObject({ interState: true, placeOfSupply: "29", cgst: 0, sgst: 0 });
    expect(row.igst).toBeGreaterThan(0);
    const receipt = (await owner.call("GET", `/orders/${r.body.id}/receipt`)).body;
    expect(JSON.stringify(receipt)).toContain("29-Karnataka");
    await payCash(r.body);
  });

  it("GSTR-1: B2B → b2b, inter-state B2C > ₹1 lakh → b2cl, smaller → b2cs with its POS; credit notes → cdnr / cdnur", async () => {
    // B2CL: inter-state, unregistered, invoice value > ₹1,00,000 (700 × ₹160 incl. GST = ₹1,12,000).
    const big = (await order({ placeOfSupply: "29", notes: "outdoor catering" }, 700)).body;
    expect(big.grandTotal).toBeGreaterThan(1_00_000_00);
    await payCash(big);
    // A second B2B buyer, then credit notes on a B2B and on the B2CL invoice.
    const b2b2 = (await order({ buyerGstin: BUYER2, buyerName: "Chennai Traders" }, 2)).body;
    await payCash(b2b2);
    expect((await owner.call("POST", `/orders/${b2b2.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 5000 })).status).toBe(201);
    expect((await owner.call("POST", `/orders/${big.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 10000 })).status).toBe(201);

    const r = await owner.call("GET", `/reports/gstr1?month=${month}`);
    expect(r.status).toBe(200);
    const g = r.body.gstr1;
    const ctins = g.b2b.map((e: { ctin: string }) => e.ctin).sort();
    expect(ctins).toEqual([BUYER, BUYER2].sort());
    const inv = g.b2b.find((e: { ctin: string }) => e.ctin === BUYER).inv[0];
    expect(inv).toMatchObject({ pos: "33", rchrg: "N", inv_typ: "R" });
    expect(inv.idt).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    expect(inv.itms[0].itm_det).toMatchObject({ rt: 5, iamt: 0 });
    expect(inv.itms[0].itm_det.camt).toBeGreaterThan(0);

    expect(g.b2cl).toHaveLength(1);
    expect(g.b2cl[0].pos).toBe("29");
    expect(g.b2cl[0].inv[0]).toMatchObject({ inum: big.invoiceNumber, val: big.grandTotal / 100 });
    expect(g.b2cl[0].inv[0].itms[0].itm_det.camt).toBeUndefined();

    // b2cs: only the small inter-state bill (POS 29) as INTER — not the B2B or B2CL invoices.
    const inter = g.b2cs.filter((b: { sply_ty: string }) => b.sply_ty === "INTER");
    expect(inter).toHaveLength(1);
    expect(inter[0].pos).toBe("29");
    const smallTx = (await db.order.findFirstOrThrow({ where: { outletId: h.outletId, placeOfSupply: "29", buyerGstin: null, NOT: { id: big.id } } })).taxableValue;
    expect(Math.round(inter[0].txval * 100)).toBe(smallTx);
    expect(g.b2cs.some((b: { sply_ty: string }) => b.sply_ty === "INTRA")).toBe(false); // every intra bill here was B2B

    expect(g.cdnr).toHaveLength(1);
    expect(g.cdnr[0]).toMatchObject({ ctin: BUYER2 });
    expect(g.cdnr[0].nt[0]).toMatchObject({ ntty: "C", val: 50, pos: "33" });
    expect(g.cdnr[0].nt[0].itms[0].itm_det.txval).toBeGreaterThan(0);
    expect(g.cdnur).toHaveLength(1);
    expect(g.cdnur[0]).toMatchObject({ typ: "B2CL", ntty: "C", val: 100, pos: "29" });

    // HSN still covers everything (net of credit notes) and matches the totals.
    const hsnTx = g.hsn.data.reduce((s: number, x: { txval: number }) => s + Math.round(x.txval * 100), 0);
    expect(Math.abs(hsnTx - r.body.totals.paise.taxable)).toBeLessThanOrEqual(g.hsn.data.length);
    // xlsx export carries the new sections
    expect((await owner.call("GET", `/reports/gstr1?month=${month}&format=xlsx`)).status).toBe(200);
  });

  it("table bills pass the buyer through", async () => {
    const table = await db.diningTable.create({ data: { outletId: h.outletId, label: `B2B${Date.now() % 10000}` } });
    const opened = await owner.call("POST", `/tables/${table.id}/open`, { guests: 2 });
    expect(opened.status).toBe(201);
    const sessionId = opened.body.id ?? opened.body.session?.id;
    expect((await owner.call("POST", `/tables/sessions/${sessionId}/items`, { items: [{ menuItemId: h.items.chai, quantity: 2, addonIds: [] }] })).status).toBeLessThan(300);
    const b = await owner.call("POST", `/tables/sessions/${sessionId}/bill`, { buyerGstin: BUYER, buyerName: "Acme Foods Pvt Ltd" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const row = await db.order.findFirstOrThrow({ where: { tableSessionId: sessionId } });
    expect(row).toMatchObject({ buyerGstin: BUYER, buyerName: "Acme Foods Pvt Ltd" });
  });
});

describe("gap 5 — coupon / offer discounts are pre-tax; gift cards are a payment", () => {
  it("a coupon reduces each line's taxable value and GST is charged on the reduced value", async () => {
    await db.coupon.create({ data: { businessId: h.businessId, code: "GAP10", discountType: "PERCENT", value: 10 } });
    const items = [
      { menuItemId: h.items.biryani, quantity: 1 },
      { menuItemId: h.items.samosa, quantity: 2 },
    ];
    const full = (await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items })).body;
    const disc = (await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items, couponCode: "GAP10" })).body;
    const lines = await db.orderItem.findMany({ where: { orderId: disc.id }, orderBy: { taxableValue: "desc" } });
    const fullLines = await db.orderItem.findMany({ where: { orderId: full.id }, orderBy: { taxableValue: "desc" } });
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      expect(l.discount).toBeGreaterThan(0);
      expect(l.taxableValue).toBe(fullLines[i]!.taxableValue - l.discount);
      expect(l.cgst + l.sgst).toBe(Math.round((l.taxableValue * 5) / 100));
    }
    const row = await db.order.findUniqueOrThrow({ where: { id: disc.id } });
    expect(row.taxableValue).toBe(Math.round(full.taxableValue * 0.9));
    expect(row.cgst + row.sgst).toBeLessThan(full.cgst + full.sgst);
  });

  it("paying with a gift card changes neither the taxable value nor the GST of the bill", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true } } });
    const card = (await owner.call("POST", "/gift-cards", { value: 100000, soldMode: "CASH" })).body;
    const o = (await order({})).body;
    const before = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    const r = await owner.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "GIFT_CARD", amount: o.grandTotal, giftCardCode: card.code }] });
    expect(r.status).toBe(200);
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after).toMatchObject({ status: "PAID", discount: before.discount, taxableValue: before.taxableValue, cgst: before.cgst, sgst: before.sgst, grandTotal: before.grandTotal });
    expect(before.discount).toBe(0);
    // Selling the card raised no tax invoice (GST is charged when it is spent on a supply).
    expect(await db.order.count({ where: { outletId: h.outletId, notes: { contains: card.code } } })).toBe(0);
  });
});

describe("gap 8 — archive a business", () => {
  let admin: Client;
  let biz: Hotel;
  beforeAll(async () => {
    const a = await createPlatformAdmin();
    admin = await login(srv.base, a.email);
    biz = await createHotel("Leaving");
  });

  it("retention end: 1 April seven years after the end of the archive's financial year (IST)", () => {
    expect(businessRetentionEnd(new Date("2026-11-09T06:00:00Z")).toISOString()).toBe("2034-03-31T18:30:00.000Z");
    expect(businessRetentionEnd(new Date("2027-03-31T17:00:00Z")).toISOString()).toBe("2034-03-31T18:30:00.000Z"); // 31 Mar 22:30 IST
    expect(businessRetentionEnd(new Date("2027-03-31T19:00:00Z")).toISOString()).toBe("2035-03-31T18:30:00.000Z"); // 1 Apr 00:30 IST
  });

  it("needs the exact name and a reason; then everyone is signed out and can't sign in; PATCH can't un-archive", async () => {
    const name = (await db.business.findUniqueOrThrow({ where: { id: biz.businessId } })).name;
    const staff = await login(srv.base, biz.users.cashier.email, biz.outletId);
    expect((await staff.call("GET", "/auth/me")).status).toBe(200);
    expect((await admin.call("POST", `/platform/businesses/${biz.businessId}/archive`, { confirmName: "wrong", reason: "Contract ended" })).status).toBe(400);
    expect((await admin.call("POST", `/platform/businesses/${biz.businessId}/archive`, { confirmName: name })).status).toBe(400);
    const r = await admin.call("POST", `/platform/businesses/${biz.businessId}/archive`, { confirmName: name.toUpperCase(), reason: "Contract ended" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ARCHIVED", archiveReason: "Contract ended" });
    expect(new Date(r.body.deleteAfter).getTime()).toBeGreaterThan(Date.now() + 6 * 365 * 86_400_000);
    expect((await staff.call("GET", "/auth/me")).status).toBe(401);
    const relog = await fetch(`${srv.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: biz.users.owner.email, password: PASSWORD }) });
    expect(relog.status).toBe(403);
    expect(((await relog.json()) as { error: string }).error).toMatch(/closed \(archived\)/);
    expect((await admin.call("PATCH", `/platform/businesses/${biz.businessId}`, { status: "ACTIVE" })).status).toBe(409);
    expect((await admin.call("POST", `/platform/businesses/${biz.businessId}/archive`, { confirmName: name, reason: "again" })).status).toBe(409);
    const audit = await db.auditLog.findFirst({ where: { action: "platform.business.archive", entityId: biz.businessId } });
    expect(audit).not.toBeNull();
    // Data is kept.
    expect(await db.menuItem.count({ where: { businessId: biz.businessId } })).toBe(3);
  });

  it("restore makes it ACTIVE again and owners sign in with their old password", async () => {
    const r = await admin.call("POST", `/platform/businesses/${biz.businessId}/restore`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ACTIVE", archivedAt: null, deleteAfter: null });
    await login(srv.base, biz.users.owner.email, biz.outletId);
    expect((await admin.call("POST", `/platform/businesses/${biz.businessId}/restore`, {})).status).toBe(409);
  });

  it("an owner can't archive their own business", async () => {
    const o = await login(srv.base, biz.users.owner.email, biz.outletId);
    expect((await o.call("POST", `/platform/businesses/${biz.businessId}/archive`, { confirmName: "x", reason: "xxx" })).status).toBe(403);
  });

  it.skip("P2 awaiting approval (known-gaps.md gap 8b): a retention job exports then hard-deletes a business once deleteAfter has passed", () => {
    // Needs: approved retention policy, an owner-downloadable final export, a purge job over every business table
    // (FK order, RLS bypass, audit tombstone) and a dry-run report. Not built: deleting tax records is irreversible.
  });
});

describe("P2 gaps awaiting approval", () => {
  it.skip("gap 4: a coupon marked combinable applies on top of the best automatic offer", () => {
    // Business rule today: one offer OR coupon per bill (bestOffer); only offers flagged `combinable` stack (Phase 3.7).
    // Coupons have no `combinable` flag. Proposal in known-gaps.md.
  });
});

// =====================================================================
describe("gap 3 — delivery partner location in the background (approved P2)", () => {
  let partner: Client;
  let deliveryId: string;
  const agent = () => h.users.delivery.id;
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const pt = (lat: number, lng: number, agoS: number, accuracy = 15) => ({ lat, lng, accuracy, at: new Date(Date.now() - agoS * 1000).toISOString() });
  const batch = (points: object[], background = true) => partner.call("POST", "/delivery/me/location/batch", { points, background });

  beforeAll(async () => {
    resetTracking();
    partner = await login(srv.base, h.users.delivery.email, h.outletId);
    const o = await order({});
    expect(o.status).toBe(201);
    deliveryId = (
      await db.delivery.create({
        data: { orderId: o.body.id, outletId: h.outletId, agentId: agent(), status: "OUT_FOR_DELIVERY", customerName: "Ravi", customerPhone: "9876543210", address: "Anna Nagar", latitude: 13.08, longitude: 80.21, pickedAt: new Date() },
      })
    ).id;
  });

  it("only while on duty: off duty → 409 OFF_DUTY with stop:true (the app ends its background task)", async () => {
    const r = await batch([pt(13.01, 80.2, 5)]);
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ code: "OFF_DUTY", stop: true });
  });

  it("per-outlet setting, off by default: background points are refused until the owner turns it on", async () => {
    await db.staffAttendance.create({ data: { userId: agent(), outletId: h.outletId, workDate: today(), clockInAt: new Date(), clockInDistance: 0 } });
    expect((await db.outlet.findUniqueOrThrow({ where: { id: h.outletId } })).backgroundTracking).toBe(false);
    const r = await batch([pt(13.01, 80.2, 5)]);
    expect(r.status).toBe(409);
    expect(r.body.details.code).toBe("BACKGROUND_OFF");
    const on = await owner.call("PATCH", "/outlets/current", { backgroundTracking: true });
    expect(on.status).toBe(200);
    expect(on.body.backgroundTracking).toBe(true);
  });

  it("only between pickup and the return: a partner at the outlet with nothing out → NOT_ON_RUN", async () => {
    await db.delivery.update({ where: { id: deliveryId }, data: { status: "PREPARING" } });
    await db.user.update({ where: { id: agent() }, data: { deliveryAtOutlet: true } });
    const r = await batch([pt(13.01, 80.2, 5)]);
    expect(r.status).toBe(409);
    expect(r.body.details.code).toBe("NOT_ON_RUN");
    await db.delivery.update({ where: { id: deliveryId }, data: { status: "OUT_FOR_DELIVERY" } });
    await db.user.update({ where: { id: agent() }, data: { deliveryAtOutlet: false, deliveryRunStartedAt: new Date() } });
  });

  it("validates and thins an offline batch server-side; only the newest valid point is applied; no history kept", async () => {
    const r = await batch([
      pt(13.02, 80.2, 300), // valid (oldest)
      pt(13.0201, 80.2, 297), // 3 s later → throttled
      pt(13.03, 80.2, 200), // valid
      pt(13.5, 80.2, 190), // 52 km in 10 s → jump
      pt(13.04, 80.2, 60, 5000), // vague fix
      pt(13.04, 80.2, 3600), // older than 30 min
      pt(13.04, 80.2, -600), // 10 min in the future
      pt(13.035, 80.2, 150), // valid (newest)
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 3, dropped: 5, stop: false, backNow: false });
    expect(r.body.reasons).toEqual({ throttled: 1, jump: 1, inaccurate: 1, stale: 1, future: 1 });
    const u = await db.user.findUniqueOrThrow({ where: { id: agent() } });
    expect(u.lastLat).toBe(13.035);
    expect(Date.now() - u.lastLocationAt!.getTime()).toBeGreaterThan(25_000); // the fix's own time, not the upload time
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const live = await manager.call("GET", "/delivery/locations");
    expect(live.body).toEqual([expect.objectContaining({ agentId: agent(), lat: 13.035, deliveryId })]);
  });

  it("throttles across batches (≥ 10 s between accepted points) and rejects bad payloads", async () => {
    const r = await batch([pt(13.036, 80.2, 145)]);
    expect(r.body).toMatchObject({ accepted: 0, dropped: 1, reasons: { throttled: 1 } });
    expect((await batch([])).status).toBe(400);
    expect((await batch(Array.from({ length: 51 }, (_, i) => pt(13, 80.2, i)))).status).toBe(400);
    expect((await batch([{ lat: 13, lng: 80.2 }])).status).toBe(400); // no timestamp
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("POST", "/delivery/me/location/batch", { points: [pt(13, 80.2, 1)] })).status).toBe(403);
  });

  it("back at the outlet after the run → backNow and stop:true; clock-out forgets the location", async () => {
    await db.delivery.update({ where: { id: deliveryId }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const r = await batch([pt(13.0, 80.2, 0)]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 1, backNow: true, atOutlet: true, stop: true });
    const out = await partner.call("POST", "/attendance/clock-out", { outletId: h.outletId, latitude: 13.0, longitude: 80.2, accuracy: 10 });
    expect(out.status).toBe(200);
    const u = await db.user.findUniqueOrThrow({ where: { id: agent() } });
    expect(u).toMatchObject({ lastLat: null, lastLng: null, lastLocationAt: null });
    expect((await batch([pt(13.01, 80.2, 0)], false)).body.details.code).toBe("OFF_DUTY");
  });
});

// =====================================================================
describe("gap 7 — clock-in face check (approved P2; manager review fallback, DPDP consent)", () => {
  let staff: Client;
  let other: Client;
  const AT = { outletId: "", latitude: 13.0, longitude: 80.2, accuracy: 10 };
  const upload = (name: string) => `${srv.base}/uploads/files/${name}.jpg`;
  const reset = (id: string) => db.staffAttendance.deleteMany({ where: { userId: id } });

  beforeAll(async () => {
    AT.outletId = h.outletId;
    staff = await login(srv.base, h.users.kitchen.email, h.outletId);
    other = await login(srv.base, h.users.inventory.email, h.outletId);
  });
  afterAll(async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
  });

  it("opt-in per business: off by default, consent is refused while the feature is off", async () => {
    const me = await staff.call("GET", "/attendance/face/me");
    expect(me.body).toMatchObject({ enabled: false, consented: false, version: FACE_CONSENT_VERSION });
    expect(me.body.notice).toMatch(/withdraw/);
    expect((await staff.call("POST", "/attendance/face/consent", { version: FACE_CONSENT_VERSION, refPhotoUrl: upload("ref-kitchen01") })).status).toBe(409);
  });

  it("explicit consent to the current notice version + reference photo enrolment through CANAVO only", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { CLOCK_IN_FACE_MATCH: true } } });
    const old = await staff.call("POST", "/attendance/face/consent", { version: "2020-01-01", refPhotoUrl: upload("ref-kitchen01") });
    expect(old.status).toBe(409);
    expect(old.body.details.code).toBe("CONSENT_OUTDATED");
    expect((await staff.call("POST", "/attendance/face/consent", { version: FACE_CONSENT_VERSION, refPhotoUrl: "https://evil.example/x.jpg" })).status).toBe(400);
    const ok = await staff.call("POST", "/attendance/face/consent", { version: FACE_CONSENT_VERSION, refPhotoUrl: upload("ref-kitchen01") });
    expect(ok.status).toBe(200);
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.kitchen.id } });
    expect(u.faceConsentVersion).toBe(FACE_CONSENT_VERSION);
    expect(u.faceConsentAt).toBeTruthy();
    expect((await db.auditLog.findFirst({ where: { action: "attendance.face_consent", entityId: h.users.kitchen.id } }))?.meta).toMatchObject({ version: FACE_CONSENT_VERSION });
    expect((await staff.call("GET", "/attendance/face/me")).body).toMatchObject({ enabled: true, consented: true });
  });

  it("consented staff need a selfie; it goes to the manager review queue with the liveness prompt and both photos", async () => {
    await reset(h.users.kitchen.id);
    const none = await staff.call("POST", "/attendance/clock-in", AT);
    expect(none.status).toBe(400);
    expect(none.body.details.code).toBe("SELFIE_REQUIRED");
    const r = await staff.call("POST", "/attendance/clock-in", { ...AT, selfieUrl: upload("selfie-k-0001"), livenessPrompt: "Blink twice" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ faceCheck: "PENDING_REVIEW", livenessPrompt: "Blink twice", faceScore: null });
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const q = await manager.call("GET", "/attendance/face/reviews");
    expect(q.status).toBe(200);
    expect(q.body).toEqual([expect.objectContaining({ id: r.body.id, refPhotoUrl: upload("ref-kitchen01"), selfieUrl: upload("selfie-k-0001"), livenessPrompt: "Blink twice", faceCheck: "PENDING_REVIEW" })]);
    expect((await staff.call("GET", "/attendance/face/reviews")).status).toBe(403);
    const rev = await manager.call("POST", `/attendance/${r.body.id}/face-review`, { decision: "REJECTED", note: "Different person" });
    expect(rev.status).toBe(200);
    expect(rev.body.faceCheck).toBe("REJECTED");
    expect(rev.body.clockInFlags).toContain("FACE_REJECTED");
    expect((await manager.call("GET", "/attendance/face/reviews")).body).toEqual([]);
    expect((await manager.call("GET", "/attendance/face/reviews?status=all")).body).toHaveLength(1);
  });

  it("an on-device mismatch never blocks clock-in: flagged + managers told; a face template is refused", async () => {
    await reset(h.users.kitchen.id);
    const tpl = await staff.call("POST", "/attendance/clock-in", { ...AT, selfieUrl: upload("selfie-k-0002"), faceMatch: { matched: true, score: 0.9, embedding: [0.1, 0.2] } });
    expect(tpl.status).toBe(400);
    const r = await staff.call("POST", "/attendance/clock-in", { ...AT, selfieUrl: upload("selfie-k-0002"), livenessPrompt: "made up", faceMatch: { matched: false, score: 0.31 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ faceCheck: "MISMATCH", faceScore: 0.31, livenessPrompt: null });
    expect(r.body.clockInFlags).toContain("FACE_MISMATCH");
    const n = await db.notification.findFirst({ where: { userId: h.users.manager.id, title: "Clock-in face check" } });
    expect(n).toBeTruthy();
  });

  it("consent is free: staff who did not agree clock in without a selfie or face check", async () => {
    await reset(h.users.inventory.id);
    const r = await other.call("POST", "/attendance/clock-in", AT);
    expect(r.status).toBe(201);
    expect(r.body.faceCheck).toBeNull();
  });

  it("withdrawing consent deletes the reference photo; deactivating a staff member erases it too", async () => {
    expect((await staff.call("DELETE", "/attendance/face/consent")).status).toBe(204);
    expect(await db.user.findUniqueOrThrow({ where: { id: h.users.kitchen.id } })).toMatchObject({ faceRefPhotoUrl: null, faceConsentAt: null, faceConsentVersion: null });
    await reset(h.users.kitchen.id);
    expect((await staff.call("POST", "/attendance/clock-in", AT)).status).toBe(201);

    await db.user.update({ where: { id: h.users.inventory.id }, data: { faceRefPhotoUrl: upload("ref-inv-0001"), faceConsentAt: new Date(), faceConsentVersion: FACE_CONSENT_VERSION } });
    expect((await owner.call("PATCH", `/staff/${h.users.inventory.id}`, { status: "INACTIVE" })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: h.users.inventory.id } })).faceRefPhotoUrl).toBeNull();
  });

  it("retention: selfies older than 90 days are purged, newer ones kept", async () => {
    const mk = (days: number, name: string) =>
      db.staffAttendance.create({
        data: { userId: h.users.cashier.id, outletId: h.outletId, workDate: "2026-01-01", clockInAt: new Date(Date.now() - days * 86_400_000), clockOutAt: new Date(Date.now() - days * 86_400_000), clockInDistance: 0, clockInSelfieUrl: upload(name) },
      });
    const [old, recent] = [await mk(91, "selfie-old-001"), await mk(89, "selfie-new-001")];
    expect(await purgeOldSelfies()).toBeGreaterThanOrEqual(1);
    expect((await db.staffAttendance.findUniqueOrThrow({ where: { id: old.id } })).clockInSelfieUrl).toBeNull();
    expect((await db.staffAttendance.findUniqueOrThrow({ where: { id: recent.id } })).clockInSelfieUrl).toBe(upload("selfie-new-001"));
  });
});
