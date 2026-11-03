/**
 * Group-E fixtures (inventory + notifications). Logins are cached per email so
 * a file stays well under the /auth/login rate limit (50 / 15 min / IP).
 */
import request from "supertest";
import bcrypt from "bcryptjs";
import type { Role } from "@canavo/shared";
import { app, createTenant, db, PASSWORD } from "./helpers";

const tokens = new Map<string, string>();

async function tokenFor(email: string) {
  const hit = tokens.get(email);
  if (hit) return hit;
  const res = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status} ${JSON.stringify(res.body)}`);
  tokens.set(email, res.body.accessToken as string);
  return res.body.accessToken as string;
}

export type Agent = Awaited<ReturnType<typeof as>>;

/** Agent for a user at an outlet (token cached per user). */
export async function as(email: string, outletId?: string) {
  const token = await tokenFor(email);
  const h = (r: request.Test) => {
    r.set("authorization", `Bearer ${token}`);
    if (outletId) r.set("x-outlet-id", outletId);
    return r;
  };
  return {
    token,
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: object) => h(request(app).post(p)).send(body),
    patch: (p: string, body?: object) => h(request(app).patch(p)).send(body),
    put: (p: string, body?: object) => h(request(app).put(p)).send(body),
    delete: (p: string) => h(request(app).delete(p)),
  };
}

let n = 0;
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** A user with a role assigned to the given outlets of a business. */
export async function addUser(businessId: string, role: Role, outletIds: string[]) {
  const tag = uid();
  const email = `${role.toLowerCase()}.x${tag}@it.canavo.test`;
  const u = await db.user.create({
    data: {
      businessId,
      name: `${role} x${tag}`,
      email,
      phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
      role,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      outlets: { create: outletIds.map((outletId) => ({ outletId })) },
    },
  });
  return { id: u.id, email };
}

/** Tenant with two outlets: outlet A (from createTenant) and outlet B with its own manager / inventory staff. */
export async function twoOutletTenant(opts: { modules?: string[] } = {}) {
  const t = await createTenant({ name: `E-Inv ${uid()}`, modules: opts.modules });
  const outletB = await db.outlet.create({ data: { businessId: t.business.id, name: `Outlet B ${uid()}`, stateCode: "33" } });
  const mgrB = await addUser(t.business.id, "OUTLET_MANAGER", [outletB.id]);
  const invB = await addUser(t.business.id, "INVENTORY_MANAGER", [outletB.id]);
  const category = await db.menuCategory.create({ data: { businessId: t.business.id, name: "Food" } });
  return { ...t, outletA: t.outlet, outletB, mgrB, invB, categoryId: category.id };
}

export type Fx = Awaited<ReturnType<typeof twoOutletTenant>>;

export async function menuItem(fx: { business: { id: string }; categoryId: string }, opts: { name?: string; price?: number; variants?: { name: string; price: number }[] } = {}) {
  return db.menuItem.create({
    data: {
      businessId: fx.business.id,
      categoryId: fx.categoryId,
      name: opts.name ?? `Dish ${uid()}`,
      price: opts.price ?? 10000,
      gstRate: 0,
      ...(opts.variants && { variants: { create: opts.variants } }),
    },
    include: { variants: true },
  });
}

/** Create an inventory item through the API; returns the body. */
export async function invItem(agent: Agent, body: Record<string, unknown> = {}) {
  const res = await agent.post("/inventory/items", { name: `Ingredient ${uid()}`, unit: "KG", ...body });
  if (res.status !== 201) throw new Error(`create item → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; unit: string; costPerUnit: number };
}

export async function stockOf(outletId: string, itemId: string) {
  const s = await db.inventoryStock.findUnique({ where: { outletId_inventoryItemId: { outletId, inventoryItemId: itemId } } });
  return s?.quantity ?? 0;
}

export async function ledgerSum(outletId: string, itemId: string) {
  const a = await db.inventoryTransaction.aggregate({ where: { outletId, inventoryItemId: itemId }, _sum: { quantity: true } });
  return Math.round((a._sum.quantity ?? 0) * 1000) / 1000;
}

export async function costOf(itemId: string) {
  return (await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).costPerUnit;
}

export const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Poll until fn returns a truthy value (fire-and-forget alerts). */
export async function waitFor<T>(fn: () => Promise<T>, ms = 2500): Promise<T> {
  const end = Date.now() + ms;
  let last = await fn();
  while (!last && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}

/** Wait a fixed short time (to assert something did NOT happen). */
export const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

export async function notesFor(userId: string, kind?: string) {
  return db.notification.findMany({ where: { userId, ...(kind && { kind }) }, orderBy: { createdAt: "desc" } });
}

export async function bill(agent: Agent, items: { menuItemId: string; variantId?: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  const res = await agent.post("/orders", { orderType: "TAKEAWAY", items, ...extra });
  if (res.status !== 201) throw new Error(`order → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; invoiceNumber: string; kots: { id: string }[] };
}
