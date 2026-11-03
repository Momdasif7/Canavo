/**
 * QA Phase 5 — group C — Kitchen (KOT / KDS) functional API tests.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "./helpers";
import { auditCount, line, menuTenant, type Agent, type MenuTenant } from "./fx-c";

let T: MenuTenant;
let cashier: Agent;
let kitchen: Agent;
let manager: Agent;

beforeAll(async () => {
  T = await menuTenant();
  cashier = await T.as("CASHIER");
  kitchen = await T.as("KITCHEN");
  manager = await T.as("OUTLET_MANAGER");
});

type Kot = { id: string; station: string; status: string; kotNumber: number; orderId: string | null; items: { name: string; quantity: number; addons: string[]; notes: string | null }[]; order: { invoiceNumber: string } | null };

async function multiStationBill(notes?: string) {
  const cheese = T.items.sandwich.addons.find((a) => a.name === "Cheese")!;
  const r = await cashier.post("/orders", {
    orderType: "TAKEAWAY",
    notes,
    items: [
      line(T.items.chai.id, 2, { variantId: T.items.chai.variants[1].id }),
      line(T.items.sandwich.id, 1, { addonIds: [cheese.id], notes: "less spicy" }),
      line(T.items.samosa.id, 3),
    ],
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; invoiceNumber: string; kots: Kot[] };
}
const kds = async (q = "") => (await kitchen.get(`/kot${q}`)).body as Kot[];

describe("KOT — creation & routing @regression", () => {
  it("IT-KOT-001 a multi-station bill creates one KOT per kitchen station with the right items", async () => {
    const b = await multiStationBill();
    expect(b.kots).toHaveLength(2);
    const byStation = Object.fromEntries(b.kots.map((k) => [k.station, k]));
    expect(Object.keys(byStation).sort()).toEqual(["BEVERAGE", "MAIN"]);
    expect(byStation.BEVERAGE.items).toEqual([{ name: "Chai (Large)", quantity: 2, addons: [], notes: null }]);
    expect(byStation.MAIN.items.map((i) => i.name)).toEqual(["Sandwich", "Samosa"]);
    expect(byStation.MAIN.items[0]).toMatchObject({ addons: ["Cheese"], notes: "less spicy" });
    expect(b.kots.every((k) => k.status === "RECEIVED")).toBe(true);
  });

  it("IT-KOT-002 KOT numbers are sequential per outlet per day", async () => {
    const a = await multiStationBill();
    const b = await multiStationBill();
    const nums = [...a.kots, ...b.kots].map((k) => k.kotNumber).sort((x, y) => x - y);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1);
  });

  it("IT-KOT-003 GET /kot lists active tickets with order summary; station filter works", async () => {
    const b = await multiStationBill();
    const all = await kds();
    const mine = all.filter((k) => k.orderId === b.id);
    expect(mine).toHaveLength(2);
    expect(mine[0].order!.invoiceNumber).toBe(b.invoiceNumber);
    const bev = await kds("?station=BEVERAGE");
    expect(bev.length).toBeGreaterThan(0);
    expect(bev.every((k) => k.station === "BEVERAGE")).toBe(true);
  });

  it("IT-KOT-004 a single-station bill creates exactly one KOT", async () => {
    const r = await cashier.post("/orders", { orderType: "DINE_IN", items: [line(T.items.samosa.id), line(T.items.biryani.id)] });
    expect(r.body.kots).toHaveLength(1);
    expect(r.body.kots[0].station).toBe("MAIN");
  });
});

describe("KOT — status flow @regression", () => {
  it("IT-KOT-005 RECEIVED → PREPARING → READY → SERVED; SERVED leaves the KDS but stays in ?all=1", async () => {
    const b = await multiStationBill();
    const k = b.kots[0];
    for (const s of ["PREPARING", "READY", "SERVED"]) {
      const r = await kitchen.patch(`/kot/${k.id}`, { status: s });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(s);
    }
    expect((await kds()).some((x) => x.id === k.id)).toBe(false);
    expect((await kds()).some((x) => x.id === b.kots[1].id)).toBe(true);
    expect((await kds("?all=1")).find((x) => x.id === k.id)?.status).toBe("SERVED");
  });

  it("IT-KOT-006 invalid status → 400; unknown KOT → 404", async () => {
    const b = await multiStationBill();
    expect((await kitchen.patch(`/kot/${b.kots[0].id}`, { status: "COOKING" })).status).toBe(400);
    expect((await kitchen.patch(`/kot/${b.kots[0].id}`, {})).status).toBe(400);
    expect((await kitchen.patch(`/kot/nope`, { status: "READY" })).status).toBe(404);
  });

  it("IT-KOT-007 @critical another tenant's KOT cannot be read, updated or printed (404)", async () => {
    const B = await menuTenant();
    const bc = await B.as("CASHIER");
    const other = (await bc.post("/orders", { orderType: "TAKEAWAY", items: [line(B.items.samosa.id)] })).body;
    const kid = other.kots[0].id;
    expect((await kitchen.patch(`/kot/${kid}`, { status: "SERVED" })).status).toBe(404);
    expect((await kitchen.post(`/kot/${kid}/print`, {})).status).toBe(404);
    expect((await kds("?all=1")).some((k) => k.id === kid)).toBe(false);
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: kid } })).status).toBe("RECEIVED");
  });

  it.fails("IT-KOT-008 (BUG-CANDIDATE-C3) a SERVED ticket cannot be moved back to RECEIVED", async () => {
    const b = await multiStationBill();
    const k = b.kots[0];
    await kitchen.patch(`/kot/${k.id}`, { status: "SERVED" });
    // Expected (RTM KOT-002 forward flow, like canTransitionDelivery for deliveries): 409/400.
    // Actual: 200 — any status can be set from any status; the ticket reappears on the KDS.
    const back = await kitchen.patch(`/kot/${k.id}`, { status: "RECEIVED" });
    expect(back.status).toBeGreaterThanOrEqual(400);
  });

  it("IT-KOT-009 cashier can view the KDS but cannot change KOT status (403)", async () => {
    const b = await multiStationBill();
    expect((await cashier.get("/kot")).status).toBe(200);
    expect((await cashier.patch(`/kot/${b.kots[0].id}`, { status: "READY" })).status).toBe(403);
  });

  it("IT-KOT-010 manager can update KOT status", async () => {
    const b = await multiStationBill();
    expect((await manager.patch(`/kot/${b.kots[0].id}`, { status: "READY" })).status).toBe(200);
  });
});

describe("KOT — print / reprint @regression", () => {
  it("IT-KOT-011 first print is plain, second is marked ** REPRINT **; both audited", async () => {
    const b = await multiStationBill("no sugar for chai");
    const main = b.kots.find((k) => k.station === "MAIN")!;
    const p1 = await kitchen.post(`/kot/${main.id}/print`, {});
    expect(p1.status).toBe(200);
    expect(p1.body.lines[0]).toMatch(new RegExp(`^KOT #${main.kotNumber}\\s+\\[MAIN\\]`));
    expect(p1.body.text).not.toContain("REPRINT");
    expect(p1.body.text).toContain(`Bill ${b.invoiceNumber}`);
    expect(p1.body.text).toContain(" 1 x Sandwich");
    expect(p1.body.text).toContain("+ Cheese");
    expect(p1.body.text).toContain("! less spicy");
    expect(p1.body.text).toContain("Note: no sugar for chai");
    const p2 = await kitchen.post(`/kot/${main.id}/print`, {});
    expect(p2.body.lines[0].startsWith("** REPRINT ** ")).toBe(true);
    expect(await auditCount(main.id, "kot.print")).toBe(1);
    expect(await auditCount(main.id, "kot.reprint")).toBe(1);
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: main.id } })).printedAt).toBeTruthy();
  });

  it("IT-KOT-012 printing an unknown KOT → 404", async () => {
    expect((await kitchen.post(`/kot/unknown/print`, {})).status).toBe(404);
  });
});

describe("KOT — roles, modules, cancellation @regression", () => {
  it("IT-KOT-013 @critical kitchen role cannot create bills, take payments or view bill history (403)", async () => {
    expect((await kitchen.post("/orders", { orderType: "TAKEAWAY", items: [line(T.items.samosa.id)] })).status).toBe(403);
    const b = await multiStationBill();
    expect((await kitchen.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: 100 }] })).status).toBe(403);
    expect((await kitchen.get("/orders")).status).toBe(403);
  });

  it("IT-KOT-014 KOT module disabled → /kot 403 while billing still works (no KOTs created)", async () => {
    const N = await menuTenant({ modules: ["BILLING", "CUSTOMERS"] });
    const c = await N.as("CASHIER");
    const k = await N.as("KITCHEN");
    expect((await k.get("/kot")).status).toBe(403);
    expect((await c.get("/kot")).status).toBe(403);
    const r = await c.post("/orders", { orderType: "TAKEAWAY", items: [line(N.items.chai.id), line(N.items.samosa.id)] });
    expect(r.status).toBe(201);
    expect(r.body.kots).toEqual([]);
  });

  it("IT-KOT-015 a cancelled bill's KOTs disappear from the KDS (also from ?all=1)", async () => {
    const b = await multiStationBill();
    expect((await kds()).filter((k) => k.orderId === b.id)).toHaveLength(2);
    await manager.post(`/orders/${b.id}/cancel`, { reason: "customer left" });
    expect((await kds()).filter((k) => k.orderId === b.id)).toHaveLength(0);
    expect((await kds("?all=1")).filter((k) => k.orderId === b.id)).toHaveLength(0);
  });

  it("IT-KOT-016 paying a takeaway bill does not remove its KOT from the KDS (kitchen still has to cook)", async () => {
    const b = await multiStationBill();
    const full = (await cashier.get(`/orders/${b.id}`)).body;
    await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: full.grandTotal }] });
    expect((await kds()).filter((k) => k.orderId === b.id)).toHaveLength(2);
  });

  it("IT-KOT-017 delivery/inventory roles cannot see the KDS (403)", async () => {
    expect((await (await T.as("DELIVERY")).get("/kot")).status).toBe(403);
    expect((await (await T.as("INVENTORY_MANAGER")).get("/kot")).status).toBe(403);
  });
});
