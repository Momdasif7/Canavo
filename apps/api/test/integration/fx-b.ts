/**
 * Phase 5 / group B fixtures (menu, import, offers, customers).
 * Logins are cached per (email, outlet): /auth/login is rate-limited to 50 per
 * 15 min per IP and every Supertest request comes from 127.0.0.1.
 */
import ExcelJS from "exceljs";
import request from "supertest";
import { app, createTenant, db, loginAs } from "./helpers";

type Agent = Awaited<ReturnType<typeof loginAs>>;
const cache = new Map<string, Promise<Agent>>();

export function as(email: string, outletId?: string): Promise<Agent> {
  const key = `${email}|${outletId ?? ""}`;
  if (!cache.has(key)) cache.set(key, loginAs(email, outletId));
  return cache.get(key)!;
}

export type Tenant = Awaited<ReturnType<typeof createTenant>>;

/** A fresh tenant plus cached agents for its roles. */
export async function tenant(opts: Parameters<typeof createTenant>[0] = {}) {
  const t = await createTenant(opts);
  const o = t.outlet.id;
  return {
    ...t,
    owner: () => as(t.users.BUSINESS_OWNER.email, o),
    manager: () => as(t.users.OUTLET_MANAGER.email, o),
    cashier: () => as(t.users.CASHIER.email, o),
    kitchen: () => as(t.users.KITCHEN.email, o),
    inventory: () => as(t.users.INVENTORY_MANAGER.email, o),
    delivery: () => as(t.users.DELIVERY.email, o),
  };
}

let n = 0;
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/** Random valid Indian mobile number. */
export const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

export async function mkCategory(businessId: string, name = `Cat ${uid()}`, parentId: string | null = null) {
  return db.menuCategory.create({ data: { businessId, name, parentId } });
}

/** Menu item straight in the DB (0% GST unless given). */
export async function mkItem(
  businessId: string,
  categoryId: string,
  price: number,
  extra: Partial<{ name: string; gstRate: number; status: "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN"; availableFrom: string; availableTo: string }> = {},
) {
  return db.menuItem.create({
    data: { businessId, categoryId, price, name: extra.name ?? `Item ${uid()}`, gstRate: extra.gstRate ?? 0, status: extra.status, availableFrom: extra.availableFrom, availableTo: extra.availableTo },
    include: { variants: true, addons: true },
  });
}

export const line = (menuItemId: string, quantity = 1, extra: Record<string, unknown> = {}) => ({ menuItemId, quantity, ...extra });

/** Create a TAKEAWAY bill. */
export function bill(agent: Agent, items: object[], extra: Record<string, unknown> = {}) {
  return agent.post("/orders", { orderType: "TAKEAWAY", items, ...extra });
}

export function pay(agent: Agent, orderId: string, amount: number, mode = "CASH") {
  return agent.post(`/orders/${orderId}/payments`, { payments: [{ mode, amount }] });
}

/** Bill + pay in full (cash). Returns the created order body. */
export async function paidBill(agent: Agent, items: object[], extra: Record<string, unknown> = {}) {
  const o = await bill(agent, items, extra);
  if (o.status !== 201) throw new Error(`order ${o.status} ${JSON.stringify(o.body)}`);
  const p = await pay(agent, o.body.id, o.body.grandTotal);
  if (p.status !== 200) throw new Error(`pay ${p.status} ${JSON.stringify(p.body)}`);
  return o.body;
}

export function preview(agent: Agent, items: object[], extra: Record<string, unknown> = {}) {
  return agent.post("/customers/preview-promotions", { orderType: "TAKEAWAY", items, ...extra });
}

/** Multipart upload to a route. */
export function upload(path: string, token: string, outletId: string, buf: Buffer, filename: string, field = "file") {
  return request(app).post(path).set("authorization", `Bearer ${token}`).set("x-outlet-id", outletId).attach(field, buf, filename);
}

export const IMPORT_HEADERS = [
  "Category *", "Sub-category", "Item name *", "Price (₹) *", "Sizes", "GST %", "Food type", "Kitchen station",
  "Description", "Image URL", "Available", "Ingredients (stock used per item)",
];
export type ImportRowIn = Partial<Record<
  "category" | "subcategory" | "name" | "price" | "sizes" | "gst" | "foodType" | "station" | "description" | "imageUrl" | "available" | "ingredients",
  ExcelJS.CellValue
>>;
const ORDER = ["category", "subcategory", "name", "price", "sizes", "gst", "foodType", "station", "description", "imageUrl", "available", "ingredients"] as const;

export async function xlsx(rows: ImportRowIn[], headers = IMPORT_HEADERS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Menu");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(ORDER.map((k) => r[k] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function csv(rows: ImportRowIn[], { bom = false } = {}): Buffer {
  const text = [IMPORT_HEADERS, ...rows.map((r) => ORDER.map((k) => r[k]))].map((r) => r.map(csvCell).join(",")).join("\n");
  return Buffer.from((bom ? "﻿" : "") + text, "utf8");
}

/** Current outlet-local (IST) minutes since midnight. */
export function istMinutes(at = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}
export const hhmm = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export { db };

/** Same token, different X-Outlet-Id (no extra login). */
export function bind(token: string, outletId: string): Agent {
  const h = (r: request.Test) => r.set("authorization", `Bearer ${token}`).set("x-outlet-id", outletId);
  return {
    token,
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: object) => h(request(app).post(p)).send(body),
    patch: (p: string, body?: object) => h(request(app).patch(p)).send(body),
    put: (p: string, body?: object) => h(request(app).put(p)).send(body),
    delete: (p: string) => h(request(app).delete(p)),
  } as Agent;
}

/** A new outlet in the business, with the given (owner) token bound to it. */
export async function outletAgent(businessId: string, token: string, extra: Record<string, unknown> = {}) {
  const o = await db.outlet.create({ data: { businessId, name: `Outlet ${uid()}`, stateCode: "33", ...extra } });
  return { outletId: o.id, agent: bind(token, o.id) };
}
