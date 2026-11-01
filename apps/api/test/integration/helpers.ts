import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { createApp } from "../../src/app";
import { platformPrisma as db } from "../../src/db";
import { initRealtime, socketEmitter } from "../../src/realtime";
import { startOutboxPublisher, stopOutboxPublisher } from "../../src/lib/outbox";
import { createDefaultTaxRates } from "../../src/services/tax-defaults";

export const PASSWORD = "Integration@123";
let pwHash: string | undefined;
const hash = async () => (pwHash ??= await bcrypt.hash(PASSWORD, 4));

/** Start the real Express app + Socket.io on a random port. */
export async function startServer() {
  const server = http.createServer(createApp());
  const io = initRealtime(server);
  startOutboxPublisher(socketEmitter());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: async () => {
      stopOutboxPublisher();
      await io.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

export interface Hotel {
  businessId: string;
  outletId: string;
  outlet2Id: string;
  users: Record<"owner" | "manager" | "cashier" | "kitchen" | "inventory" | "delivery", { id: string; email: string }>;
  items: { chai: string; samosa: string; biryani: string };
}

/** A complete hotel: business (all modules), 2 outlets, one user per role, 3 menu items. */
export async function createHotel(name = "IT Hotel", opts: { modules?: string[]; gst?: boolean } = {}): Promise<Hotel> {
  const tag = uniq();
  const business = await db.business.create({
    data: { name: `${name} ${tag}`, modules: opts.modules ?? ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS"] },
  });
  await createDefaultTaxRates(db as never, business.id);
  const mk = (n: string) =>
    db.outlet.create({ data: { businessId: business.id, name: `${n} ${tag}`, stateCode: "33", gstEnabled: opts.gst ?? false, latitude: 13.0, longitude: 80.2 } });
  const [o1, o2] = [await mk("Main"), await mk("Second")];
  const user = async (role: Role, key: string, outlets: string[]) => {
    const email = `${key}.${tag}@it.local`;
    const u = await db.user.create({
      data: { businessId: business.id, role, name: `${key} ${tag}`, email, phone: phone(), passwordHash: await hash(), outlets: { create: outlets.map((outletId) => ({ outletId })) } },
    });
    return { id: u.id, email };
  };
  const users = {
    owner: await user("BUSINESS_OWNER", "owner", []),
    manager: await user("OUTLET_MANAGER", "manager", [o1.id]),
    cashier: await user("CASHIER", "cashier", [o1.id]),
    kitchen: await user("KITCHEN", "kitchen", [o1.id]),
    inventory: await user("INVENTORY_MANAGER", "inventory", [o1.id]),
    delivery: await user("DELIVERY", "delivery", [o1.id]),
  };
  const cat = await db.menuCategory.create({ data: { businessId: business.id, name: "Snacks" } });
  const item = (n: string, price: number) => db.menuItem.create({ data: { businessId: business.id, categoryId: cat.id, name: n, price, gstRate: 5 } });
  const items = { chai: (await item("Chai", 1500)).id, samosa: (await item("Samosa", 3000)).id, biryani: (await item("Biryani", 16000)).id };
  return { businessId: business.id, outletId: o1.id, outlet2Id: o2.id, users, items };
}

export interface Client {
  token: string;
  call: <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T; headers: Headers }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Log in through the API; calls carry the bearer token and (optionally) an outlet header. */
export async function login(base: string, email: string, outletId?: string): Promise<Client> {
  const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${await r.text()}`);
  const { accessToken } = (await r.json()) as { accessToken: string };
  return {
    token: accessToken,
    call: async (method, path, body, headers = {}) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...(outletId && { "x-outlet-id": outletId }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      return { status: res.status, body: parsed as never, headers: res.headers };
    },
  };
}

export { db };
