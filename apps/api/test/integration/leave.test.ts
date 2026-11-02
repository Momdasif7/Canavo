/** Leave requests: every clocking-in role can ask; managers review their outlet's staff; owners review owners. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { createHotel, db, login, PASSWORD, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Leave");
});
afterAll(() => srv.close());

describe("leave requests", () => {
  it("cashier, kitchen, delivery and inventory staff can ask for leave and see their own requests", async () => {
    for (const k of ["cashier", "kitchen", "delivery", "inventory"] as const) {
      const c = await login(srv.base, h.users[k].email, h.outletId);
      const r = await c.call("POST", "/attendance/leaves", { fromDate: day(3), toDate: day(4), type: "CASUAL", reason: `${k} family function` });
      expect(r.status, k).toBe(201);
      const mine = (await c.call("GET", "/attendance/leaves")).body as { userId: string }[];
      expect(mine.every((l) => l.userId === h.users[k].id)).toBe(true);
    }
    // The manager sees them and approves one; staff can't approve.
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const list = (await manager.call("GET", "/attendance/leaves?scope=outlet")).body as { id: string; userId: string }[];
    const cashierLeave = list.find((l) => l.userId === h.users.cashier.id)!;
    expect(cashierLeave).toBeTruthy();
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("PATCH", `/attendance/leaves/${cashierLeave.id}`, { status: "APPROVED" })).status).toBe(403);
    expect((await manager.call("PATCH", `/attendance/leaves/${cashierLeave.id}`, { status: "APPROVED" })).body.status).toBe("APPROVED");
  });

  it("an owner's leave is reviewed by another owner (managers don't see it); nobody approves their own", async () => {
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    const ask = await owner.call("POST", "/attendance/leaves", { fromDate: day(5), toDate: day(5), type: "SICK" });
    expect(ask.status).toBe(201);
    expect((await owner.call("PATCH", `/attendance/leaves/${ask.body.id}`, { status: "APPROVED" })).status).toBe(403);
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("PATCH", `/attendance/leaves/${ask.body.id}`, { status: "APPROVED" })).status).toBe(404);
    const second = await db.user.create({
      data: { businessId: h.businessId, role: "BUSINESS_OWNER", name: "Second Owner", email: `owner2.${Date.now()}@it.local`, phone: `9${String(Date.now()).slice(-9)}`, passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    const co = await login(srv.base, second.email!, h.outletId);
    const seen = (await co.call("GET", "/attendance/leaves?scope=outlet")).body as { id: string }[];
    expect(seen.some((l) => l.id === ask.body.id)).toBe(true);
    expect((await co.call("PATCH", `/attendance/leaves/${ask.body.id}`, { status: "APPROVED" })).body.status).toBe("APPROVED");
  });
});
