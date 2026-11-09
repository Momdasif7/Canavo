/**
 * P2 gap 8b (docs/qa/known-gaps.md) — delete an archived business after its retention date.
 * Final export offered to the owners first (30 days' notice), super-admin approval with typed confirmation,
 * refused before the retention date, hard delete of every business row and uploaded file, a tombstone and the
 * platform audit entries kept, and an idempotent retention job that resumes a half-done purge.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, createPlatformAdmin, db, login, startServer, type Client, type Hotel } from "./helpers";
import { platformPrisma } from "../../src/db";
import { offerFinalExport, runBusinessRetention } from "../../src/services/business-purge";
import { storageDir } from "../../src/services/storage";

let srv: Awaited<ReturnType<typeof startServer>>;
let admin: Client;
let other: Hotel;
const DAY = 86_400_000;

beforeAll(async () => {
  srv = await startServer();
  admin = await login(srv.base, (await createPlatformAdmin()).email);
  other = await createHotel("Neighbour");
});
afterAll(() => srv.close());

async function archived(label: string) {
  const h = await createHotel(label);
  const name = (await db.business.findUniqueOrThrow({ where: { id: h.businessId } })).name;
  const r = await admin.call("POST", `/platform/businesses/${h.businessId}/archive`, { confirmName: name, reason: "Contract ended" });
  expect(r.status).toBe(200);
  return { h, name };
}
const purge = (id: string, body: object) => admin.call("POST", `/platform/businesses/${id}/purge`, body);

describe("gap 8b — delete an archived business after retention", () => {
  let h: Hotel;
  let name: string;
  let upload: string;
  let orderId: string;

  beforeAll(async () => {
    const created = await createHotel("Purge");
    h = created;
    name = (await db.business.findUniqueOrThrow({ where: { id: h.businessId } })).name;
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    const o = await owner.call("POST", "/orders", { orderType: "TAKEAWAY", customerPhone: "9876512345", items: [{ menuItemId: h.items.chai, quantity: 2 }] });
    expect(o.status).toBe(201);
    orderId = o.body.id;
    upload = `purge-${Date.now().toString(36)}abc.png`;
    writeFileSync(path.join(storageDir("uploads"), upload), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await db.menuItem.update({ where: { id: h.items.chai }, data: { imageUrl: `http://localhost:4000/uploads/files/${upload}` } });
    const r = await admin.call("POST", `/platform/businesses/${h.businessId}/archive`, { confirmName: name, reason: "Left the platform" });
    expect(r.status).toBe(200);
  });

  it("dry run lists row counts and what blocks the purge; refused before the retention date", async () => {
    const p = await admin.call("GET", `/platform/businesses/${h.businessId}/purge-preview`);
    expect(p.status).toBe(200);
    expect(p.body.canPurge).toBe(false);
    expect(p.body.blockers.join(" ")).toMatch(/retention period runs until/);
    expect(p.body.tables).toMatchObject({ MenuItem: 3, Order: 1, Customer: 1 });
    const r = await purge(h.businessId, { confirmName: name, confirmText: "DELETE" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/retention period runs until/);
    expect(await db.business.count({ where: { id: h.businessId } })).toBe(1);
  });

  it("past the retention date it still needs the owner's final export, offered 30 days earlier", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { deleteAfter: new Date(Date.now() - DAY) } });
    expect((await purge(h.businessId, { confirmName: name, confirmText: "DELETE" })).body.error).toMatch(/final export hasn't been offered/);
    const ex = await admin.call("POST", `/platform/businesses/${h.businessId}/final-export`, {});
    expect(ex.status).toBe(200);
    expect(ex.body.sentTo).toBe(1);
    expect(JSON.stringify(ex.body)).not.toMatch(/business-export/); // the operator never gets the link
    const r = await purge(h.businessId, { confirmName: name, confirmText: "DELETE" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/30 days' notice/);
  });

  it("the owner downloads the final export with the emailed one-time link; a new link replaces the old one", async () => {
    const first = await offerFinalExport(h.businessId);
    const second = await offerFinalExport(h.businessId);
    expect((await fetch(`${srv.base}/public/business-export/${first.token}`)).status).toBe(404);
    const dl = await fetch(`${srv.base}/public/business-export/${second.token}`);
    expect(dl.status).toBe(200);
    const buf = Buffer.from(await dl.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.toString("latin1")).toContain("MenuItem.csv");
    // The offer date (start of the notice) stays the first one.
    expect(second.finalExportAt.getTime()).toBe(first.finalExportAt.getTime());
  });

  it("typed confirmation: the exact name and DELETE; owners and support users can't purge", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { finalExportAt: new Date(Date.now() - 31 * DAY) } });
    expect((await purge(h.businessId, { confirmName: "wrong", confirmText: "DELETE" })).status).toBe(400);
    expect((await purge(h.businessId, { confirmName: name, confirmText: "delete" })).status).toBe(400);
    const owner = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await owner.call("POST", `/platform/businesses/${h.businessId}/purge`, { confirmName: name, confirmText: "DELETE" })).status).toBe(403);
    expect(await db.business.count({ where: { id: h.businessId } })).toBe(1);
  });

  it("purge: every business row and uploaded file is gone; tombstone + platform audit stay; other hotels untouched", async () => {
    const otherItems = await db.menuItem.count({ where: { businessId: other.businessId } });
    const exportFile = (await db.business.findUniqueOrThrow({ where: { id: h.businessId } })).finalExportFile!;
    const r = await purge(h.businessId, { confirmName: name.toUpperCase(), confirmText: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.body.completedAt).toBeTruthy();
    expect(r.body.rowCounts).toMatchObject({ Business: 1, MenuItem: 3, Order: 1, Outlet: 2 });
    expect(r.body.filesDeleted).toBe(1);
    expect(existsSync(path.join(storageDir("uploads"), upload))).toBe(false);
    expect(existsSync(path.join(storageDir("exports"), exportFile))).toBe(false);

    expect(await db.business.count({ where: { id: h.businessId } })).toBe(0);
    expect(await db.outlet.count({ where: { businessId: h.businessId } })).toBe(0);
    expect(await db.user.count({ where: { businessId: h.businessId } })).toBe(0);
    expect(await db.order.count({ where: { id: orderId } })).toBe(0);
    expect(await db.orderItem.count({ where: { orderId } })).toBe(0);
    expect(await db.customer.count({ where: { businessId: h.businessId } })).toBe(0);
    expect(await db.auditLog.count({ where: { businessId: h.businessId } })).toBe(0);
    expect(await db.setting.count({ where: { scope: h.businessId } })).toBe(0);
    expect(await db.menuItem.count({ where: { businessId: other.businessId } })).toBe(otherItems);

    const tomb = await platformPrisma.businessTombstone.findUniqueOrThrow({ where: { id: h.businessId } });
    expect(tomb.nameHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tomb)).not.toContain(name);
    const actions = (await db.auditLog.findMany({ where: { entityId: h.businessId, businessId: null }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["platform.business.archive", "platform.business.final_export", "platform.business.purge"]));
  });

  it("idempotent: approving again returns the tombstone; the job has nothing to redo", async () => {
    const again = await purge(h.businessId, { confirmName: name, confirmText: "DELETE" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(h.businessId);
    const job = await runBusinessRetention();
    expect(job.resumed).not.toContain(h.businessId);
    expect((await admin.call("GET", "/platform/business-tombstones")).body.some((t: { id: string }) => t.id === h.businessId)).toBe(true);
  });
});

describe("gap 8b — retention job", () => {
  it("offers the final export once, 30 days before deleteAfter (idempotent); never purges without approval", async () => {
    const { h } = await archived("Notice");
    await db.business.update({ where: { id: h.businessId }, data: { deleteAfter: new Date(Date.now() + 10 * DAY) } });
    const first = await runBusinessRetention();
    expect(first.offered).toContain(h.businessId);
    const b1 = await db.business.findUniqueOrThrow({ where: { id: h.businessId } });
    expect(b1.finalExportAt).not.toBeNull();
    const second = await runBusinessRetention();
    expect(second.offered).not.toContain(h.businessId);
    const b2 = await db.business.findUniqueOrThrow({ where: { id: h.businessId } });
    expect(b2.finalExportTokenHash).toBe(b1.finalExportTokenHash);

    // Past retention and notice: listed for approval, still not deleted.
    await db.business.update({ where: { id: h.businessId }, data: { deleteAfter: new Date(Date.now() - DAY), finalExportAt: new Date(Date.now() - 40 * DAY) } });
    const third = await runBusinessRetention();
    expect(third.awaitingApproval).toContain(h.businessId);
    expect(await db.business.count({ where: { id: h.businessId } })).toBe(1);
  });

  it("resumes an approved purge that stopped half way", async () => {
    const { h, name } = await archived("Resume");
    await db.business.update({ where: { id: h.businessId }, data: { deleteAfter: new Date(Date.now() - DAY), finalExportAt: new Date(Date.now() - 40 * DAY) } });
    // Simulate a crash right after approval: tombstone written, some rows already gone.
    await platformPrisma.businessTombstone.create({ data: { id: h.businessId, nameHash: "x".repeat(64), businessCreatedAt: new Date(), deleteAfter: new Date(Date.now() - DAY), rowCounts: { MenuItem: 1 } } });
    await db.menuItem.delete({ where: { id: h.items.chai } });
    const job = await runBusinessRetention();
    expect(job.resumed).toContain(h.businessId);
    expect(await db.business.count({ where: { id: h.businessId } })).toBe(0);
    const tomb = await platformPrisma.businessTombstone.findUniqueOrThrow({ where: { id: h.businessId } });
    expect(tomb.completedAt).not.toBeNull();
    expect((tomb.rowCounts as Record<string, number>).MenuItem).toBe(3);
    expect(name).toBeTruthy();
  });

  it("a hotel can't see tombstones (platform-only RLS)", async () => {
    const owner = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await owner.call("GET", "/platform/business-tombstones")).status).toBe(403);
  });
});
