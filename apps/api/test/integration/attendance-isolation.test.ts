/**
 * BUG-005 — GET /attendance/calendar?userId= must not expose another
 * business's (or an unmanaged outlet's) staff attendance and leave.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db, demoTenant, loginAs } from "./helpers";

describe("@critical @regression attendance calendar isolation (BUG-005)", () => {
  let victim: Awaited<ReturnType<typeof createTenant>>;
  const month = "2026-10";

  beforeAll(async () => {
    victim = await createTenant({ name: "Victim Hotel" });
    const staff = victim.users.CASHIER.id;
    await db.staffAttendance.create({
      data: {
        userId: staff,
        outletId: victim.outlet.id,
        workDate: "2026-10-05",
        clockInAt: new Date("2026-10-05T03:30:00Z"),
        clockInDistance: 5,
        note: "VICTIM-SECRET-NOTE",
      },
    });
    await db.leaveRequest.create({
      data: { userId: staff, fromDate: "2026-10-10", toDate: "2026-10-11", type: "SICK", reason: "VICTIM-SECRET", status: "APPROVED" },
    });
  });

  it("ISO-ATT-001 a manager of another business gets 403/404 and no records", async () => {
    const { outlet } = await demoTenant();
    const attacker = await loginAs("manager@canavo.local", outlet.id);
    const res = await attacker.get(`/attendance/calendar?month=${month}&userId=${victim.users.CASHIER.id}`);
    expect(JSON.stringify(res.body)).not.toContain("VICTIM-SECRET");
    expect([403, 404]).toContain(res.status);
  });

  it("ISO-ATT-002 an owner of another business gets 403/404", async () => {
    const attacker = await loginAs("owner@canavo.local");
    const res = await attacker.get(`/attendance/calendar?month=${month}&userId=${victim.users.CASHIER.id}`);
    expect(JSON.stringify(res.body)).not.toContain("VICTIM-SECRET");
    expect([403, 404]).toContain(res.status);
  });

  it("ISO-ATT-003 the victim's own manager still sees the staff calendar", async () => {
    const mgr = await loginAs(victim.users.OUTLET_MANAGER.email, victim.outlet.id);
    const res = await mgr.get(`/attendance/calendar?month=${month}&userId=${victim.users.CASHIER.id}`);
    expect(res.status).toBe(200);
    const day = res.body.days.find((d: { date: string }) => d.date === "2026-10-05");
    expect(day.records).toHaveLength(1);
  });

  it("ISO-ATT-004 staff still see their own calendar", async () => {
    const me = await loginAs(victim.users.CASHIER.email);
    const res = await me.get(`/attendance/calendar?month=${month}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(victim.users.CASHIER.id);
  });

  it("ISO-ATT-005 a manager cannot read a same-business staff member of an outlet they don't manage", async () => {
    // Second outlet in the victim business with its own cashier; victim manager is NOT assigned to it.
    const other = await db.outlet.create({ data: { businessId: victim.business.id, name: "Victim Outlet 2", stateCode: "33" } });
    const u = await db.user.create({
      data: {
        businessId: victim.business.id, name: "Other cashier", email: `oc.${other.id}@it.canavo.test`,
        phone: `7${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, role: "CASHIER", outlets: { create: { outletId: other.id } },
      },
    });
    const mgr = await loginAs(victim.users.OUTLET_MANAGER.email, victim.outlet.id);
    const res = await mgr.get(`/attendance/calendar?month=${month}&userId=${u.id}`);
    expect([403, 404]).toContain(res.status);
  });
});
