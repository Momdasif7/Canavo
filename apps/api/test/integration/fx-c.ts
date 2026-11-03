/**
 * Group C (billing / KOT / tables / reservations) fixtures.
 *
 * - `agentFor(email, outletId)` caches one login per (email, outlet): POST
 *   /auth/login is rate-limited to ~50 per 15 min per IP, so a file must not
 *   log in per test.
 * - `menuTenant()` = createTenant() plus a known menu (two GST rates, two kitchen
 *   stations, variants, add-ons, hidden / out-of-stock / out-of-slot items), a
 *   floor plan, packaging charge and a UPI VPA. No offers, so totals are
 *   predictable and comparable with `computeBill`.
 */
import type { Role } from "@canavo/shared";
import { createTenant, db, demoTenant, loginAs } from "./helpers";

export type Agent = Awaited<ReturnType<typeof loginAs>>;

const agents = new Map<string, Promise<Agent>>();
export function agentFor(email: string, outletId?: string): Promise<Agent> {
  const key = `${email}|${outletId ?? ""}`;
  if (!agents.has(key)) agents.set(key, loginAs(email, outletId));
  return agents.get(key)!;
}

/** "HH:MM" `h` hours from now in IST. */
function istHour(offsetH: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date());
  const h = (Number(parts) + offsetH + 24) % 24;
  return `${String(h).padStart(2, "0")}:00`;
}

/** Random valid Indian mobile number. */
export function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
}

export async function menuTenant(opts: { modules?: string[] } = {}) {
  const t = await createTenant({ modules: opts.modules });
  const businessId = t.business.id;
  const outletId = t.outlet.id;
  await db.outlet.update({ where: { id: outletId }, data: { packagingCharge: 500, upiVpa: "itc@okaxis", deliveryEnabled: true } });
  const gst5 = await db.taxRate.create({ data: { businessId, name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5, isDefault: true } });
  const gst18 = await db.taxRate.create({ data: { businessId, name: "GST 18%", cgst: 9, sgst: 9, igst: 18 } });
  const cat = await db.menuCategory.create({ data: { businessId, name: "All" } });
  const mk = (data: {
    name: string; price: number; station?: string; taxRateId?: string; gstRate?: number; status?: "AVAILABLE" | "HIDDEN" | "OUT_OF_STOCK";
    availableFrom?: string; availableTo?: string; variants?: [string, number][]; addons?: [string, number][];
  }) =>
    db.menuItem.create({
      data: {
        businessId,
        categoryId: cat.id,
        name: data.name,
        price: data.price,
        taxRateId: data.taxRateId ?? gst5.id,
        gstRate: data.gstRate ?? 5,
        kitchenStation: data.station ?? "MAIN",
        status: data.status ?? "AVAILABLE",
        availableFrom: data.availableFrom,
        availableTo: data.availableTo,
        variants: { create: (data.variants ?? []).map(([name, price]) => ({ name, price })) },
        addons: { create: (data.addons ?? []).map(([name, price]) => ({ name, price })) },
      },
      include: { variants: true, addons: true },
    });
  const chai = await mk({ name: "Chai", price: 1500, station: "BEVERAGE", variants: [["Regular", 1500], ["Large", 2500]] });
  const sandwich = await mk({ name: "Sandwich", price: 5000, addons: [["Cheese", 2000], ["No onion", 0]] });
  const samosa = await mk({ name: "Samosa", price: 3500 });
  const biryani = await mk({ name: "Biryani", price: 16000, taxRateId: gst18.id, gstRate: 18 });
  const hidden = await mk({ name: "Hidden Dish", price: 1000, status: "HIDDEN" });
  const oos = await mk({ name: "Sold Out Dish", price: 1000, status: "OUT_OF_STOCK" });
  const offSlot = await mk({ name: "Off Slot Dish", price: 1000, availableFrom: istHour(2), availableTo: istHour(3) });
  const area = await db.diningArea.create({ data: { outletId, name: "Hall" } });
  const table = (label: string, capacity: number) => db.diningTable.create({ data: { outletId, areaId: area.id, label, capacity } });
  const tables = { T1: await table("T1", 2), T2: await table("T2", 4), T3: await table("T3", 4), T4: await table("T4", 6) };
  const as = (role: Role) => agentFor(t.users[role].email, outletId);
  return { ...t, businessId, outletId, gst5, gst18, cat, area, tables, items: { chai, sandwich, samosa, biryani, hidden, oos, offSlot }, as };
}
export type MenuTenant = Awaited<ReturnType<typeof menuTenant>>;

export async function demo() {
  const d = await demoTenant();
  const as = (who: "owner" | "manager" | "cashier" | "kitchen") => agentFor(`${who}@canavo.local`, d.outlet.id);
  return { ...d, outletId: d.outlet.id, as };
}

/** Simple takeaway bill line. */
export const line = (menuItemId: string, quantity = 1, extra: Record<string, unknown> = {}) => ({ menuItemId, quantity, ...extra });

export async function auditCount(entityId: string, action: string) {
  return db.auditLog.count({ where: { entityId, action } });
}
