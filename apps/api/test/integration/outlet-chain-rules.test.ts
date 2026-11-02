/**
 * Cross-outlet writes and approval-chain rules found in the Phase 3 review.
 *   BUG-010  manual attendance overwrites the staff member's record at ANOTHER outlet
 *   BUG-011  a manager can approve a peer manager's leave (rank check missing)
 *   BUG-012  a manager editing staff outlets silently removes outlets they don't manage
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db, loginAs } from "./helpers";

let t: Awaited<ReturnType<typeof createTenant>>;
let outlet2: { id: string };

beforeAll(async () => {
  t = await createTenant({ name: "Two-outlet Hotel" });
  outlet2 = await db.outlet.create({ data: { businessId: t.business.id, name: "Second outlet", stateCode: "33" } });
  // The cashier works at both outlets; the manager manages only outlet 1.
  await db.userOutlet.create({ data: { userId: t.users.CASHIER.id, outletId: outlet2.id } });
});

describe("@critical @regression BUG-010 manual attendance stays in the manager's outlet", () => {
  it("CON-ATT-001 marking ABSENT at outlet 1 does not overwrite the clock-in at outlet 2", async () => {
    const date = "2026-10-20";
    const atB = await db.staffAttendance.create({
      data: { userId: t.users.CASHIER.id, outletId: outlet2.id, workDate: date, clockInAt: new Date("2026-10-20T03:30:00Z"), clockInDistance: 3, status: "PRESENT" },
    });
    const mgr = await loginAs(t.users.OUTLET_MANAGER.email, t.outlet.id);
    const res = await mgr.post("/attendance/manual", { userId: t.users.CASHIER.id, date, status: "ABSENT" });
    expect(res.status).toBeLessThan(300);
    const after = await db.staffAttendance.findUniqueOrThrow({ where: { id: atB.id } });
    expect(after.status).toBe("PRESENT");
    expect(after.markedById).toBeNull();
    const atA = await db.staffAttendance.findFirst({ where: { userId: t.users.CASHIER.id, outletId: t.outlet.id, workDate: date } });
    expect(atA?.status).toBe("ABSENT");
  });
});

describe("@regression BUG-011 leave approval follows the rank chain", () => {
  it("CON-LV-001 a manager cannot approve a peer manager's leave", async () => {
    const peer = await db.user.create({
      data: {
        businessId: t.business.id, name: "Peer manager", email: `peer.${t.outlet.id}@it.canavo.test`, role: "OUTLET_MANAGER",
        phone: `7${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, outlets: { create: { outletId: t.outlet.id } },
      },
    });
    const leave = await db.leaveRequest.create({ data: { userId: peer.id, fromDate: "2026-11-20", toDate: "2026-11-21", type: "CASUAL" } });
    const mgr = await loginAs(t.users.OUTLET_MANAGER.email, t.outlet.id);
    const res = await mgr.patch(`/attendance/leaves/${leave.id}`, { status: "APPROVED" });
    expect(res.status).toBe(403);
    expect((await db.leaveRequest.findUniqueOrThrow({ where: { id: leave.id } })).status).toBe("PENDING");
  });

  it("CON-LV-002 a manager can still approve a cashier's leave", async () => {
    const leave = await db.leaveRequest.create({ data: { userId: t.users.CASHIER.id, fromDate: "2026-11-22", toDate: "2026-11-22", type: "SICK" } });
    const mgr = await loginAs(t.users.OUTLET_MANAGER.email, t.outlet.id);
    const res = await mgr.patch(`/attendance/leaves/${leave.id}`, { status: "APPROVED" });
    expect(res.status).toBe(200);
  });
});

describe("@regression BUG-012 staff outlet edits keep outlets the editor doesn't manage", () => {
  it("CON-STF-001 manager of outlet 1 setting outletIds=[outlet1] keeps the outlet 2 assignment", async () => {
    const mgr = await loginAs(t.users.OUTLET_MANAGER.email, t.outlet.id);
    const res = await mgr.patch(`/staff/${t.users.CASHIER.id}`, { outletIds: [t.outlet.id] });
    expect(res.status).toBe(200);
    const links = await db.userOutlet.findMany({ where: { userId: t.users.CASHIER.id } });
    expect(links.map((l) => l.outletId).sort()).toEqual([t.outlet.id, outlet2.id].sort());
  });
});
