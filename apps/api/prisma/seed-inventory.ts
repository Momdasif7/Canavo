import type { PrismaClient, StockUnit } from "@prisma/client";

const rs = (n: number) => Math.round(n * 100);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type ItemSeed = {
  key: string;
  name: string;
  category: string;
  unit: StockUnit;
  cost: number; // ₹ per unit
  reorder: number;
  reorderQty: number;
  opening: number;
  sku: string;
  barcode?: string;
};

const ITEMS: ItemSeed[] = [
  { key: "milk", name: "Milk (toned)", category: "Dairy", unit: "L", cost: 56, reorder: 10, reorderQty: 40, opening: 40, sku: "DAI-MILK", barcode: "8901262010016" },
  { key: "paneer", name: "Paneer", category: "Dairy", unit: "KG", cost: 380, reorder: 2, reorderQty: 5, opening: 6, sku: "DAI-PANR", barcode: "8901262150019" },
  { key: "curd", name: "Curd", category: "Dairy", unit: "KG", cost: 70, reorder: 3, reorderQty: 10, opening: 8, sku: "DAI-CURD" },
  { key: "butter", name: "Butter", category: "Dairy", unit: "KG", cost: 520, reorder: 1, reorderQty: 2, opening: 2, sku: "DAI-BUTR", barcode: "8901262200011" },
  { key: "cheese", name: "Cheese slices (10 pc)", category: "Dairy", unit: "PACKET", cost: 140, reorder: 3, reorderQty: 10, opening: 8, sku: "DAI-CHSL", barcode: "8901262250016" },
  { key: "tea", name: "Tea powder", category: "Beverages", unit: "KG", cost: 480, reorder: 1, reorderQty: 3, opening: 3, sku: "BEV-TEA", barcode: "8901725181109" },
  { key: "coffee", name: "Filter coffee powder", category: "Beverages", unit: "KG", cost: 720, reorder: 1, reorderQty: 2, opening: 2.5, sku: "BEV-COFF", barcode: "8901725181208" },
  { key: "sugar", name: "Sugar", category: "Grocery", unit: "KG", cost: 44, reorder: 5, reorderQty: 25, opening: 20, sku: "GRO-SUGR" },
  { key: "rice", name: "Basmati rice", category: "Grocery", unit: "KG", cost: 110, reorder: 10, reorderQty: 25, opening: 30, sku: "GRO-BRIC", barcode: "8906009070017" },
  { key: "oil", name: "Sunflower oil", category: "Grocery", unit: "L", cost: 145, reorder: 5, reorderQty: 15, opening: 15, sku: "GRO-OIL", barcode: "8901058000047" },
  { key: "atta", name: "Wheat atta", category: "Grocery", unit: "KG", cost: 48, reorder: 5, reorderQty: 20, opening: 15, sku: "GRO-ATTA" },
  { key: "besan", name: "Besan (gram flour)", category: "Grocery", unit: "KG", cost: 90, reorder: 2, reorderQty: 5, opening: 5, sku: "GRO-BESN" },
  { key: "batter", name: "Idli/dosa batter", category: "Grocery", unit: "KG", cost: 60, reorder: 4, reorderQty: 10, opening: 10, sku: "GRO-BATR" },
  { key: "gjmix", name: "Gulab jamun mix (200 g)", category: "Grocery", unit: "PACKET", cost: 95, reorder: 2, reorderQty: 6, opening: 5, sku: "GRO-GJMX", barcode: "8901020000013" },
  { key: "potato", name: "Potatoes", category: "Vegetables", unit: "KG", cost: 30, reorder: 10, reorderQty: 25, opening: 25, sku: "VEG-POTA" },
  { key: "onion", name: "Onions", category: "Vegetables", unit: "KG", cost: 35, reorder: 10, reorderQty: 25, opening: 20, sku: "VEG-ONIO" },
  { key: "tomato", name: "Tomatoes", category: "Vegetables", unit: "KG", cost: 28, reorder: 5, reorderQty: 15, opening: 10, sku: "VEG-TOMA" },
  { key: "veg", name: "Mixed vegetables", category: "Vegetables", unit: "KG", cost: 60, reorder: 5, reorderQty: 10, opening: 8, sku: "VEG-MIXD" },
  { key: "lemon", name: "Lemons", category: "Vegetables", unit: "PIECE", cost: 4, reorder: 20, reorderQty: 100, opening: 60, sku: "VEG-LEMN" },
  { key: "chicken", name: "Chicken (curry cut)", category: "Meat & Eggs", unit: "KG", cost: 240, reorder: 4, reorderQty: 10, opening: 10, sku: "MEA-CHKN" },
  { key: "eggs", name: "Eggs", category: "Meat & Eggs", unit: "PIECE", cost: 6.5, reorder: 30, reorderQty: 90, opening: 90, sku: "MEA-EGGS" },
  { key: "bread", name: "Sandwich bread", category: "Bakery", unit: "PACKET", cost: 45, reorder: 4, reorderQty: 12, opening: 10, sku: "BAK-BRED", barcode: "8904004400014" },
  { key: "pav", name: "Pav buns (6 pc)", category: "Bakery", unit: "PACKET", cost: 30, reorder: 4, reorderQty: 12, opening: 10, sku: "BAK-PAV" },
  { key: "sheets", name: "Samosa sheets (25 pc)", category: "Bakery", unit: "PACKET", cost: 60, reorder: 3, reorderQty: 10, opening: 8, sku: "BAK-SMSH" },
  { key: "puff", name: "Puff pastry sheets (10 pc)", category: "Bakery", unit: "PACKET", cost: 90, reorder: 2, reorderQty: 6, opening: 5, sku: "BAK-PUFF" },
  { key: "mango", name: "Mango pulp", category: "Beverages", unit: "L", cost: 160, reorder: 2, reorderQty: 6, opening: 4, sku: "BEV-MPLP", barcode: "8901030000018" },
  { key: "kulfi", name: "Kulfi (ready, pc)", category: "Frozen", unit: "PIECE", cost: 18, reorder: 15, reorderQty: 50, opening: 40, sku: "FRZ-KLFI" },
  { key: "almond", name: "Almonds", category: "Grocery", unit: "KG", cost: 900, reorder: 0.5, reorderQty: 1, opening: 1, sku: "GRO-ALMD" },
  { key: "soda", name: "Soda (750 ml)", category: "Beverages", unit: "PIECE", cost: 20, reorder: 12, reorderQty: 48, opening: 36, sku: "BEV-SODA", barcode: "8901764012709" },
];

/** Recipe lines per menu item; `variants` override the default for named variants. Quantities in item units. */
type Lines = Record<string, number>;
const RECIPES: { menu: string; base?: Lines; variants?: Record<string, Lines> }[] = [
  {
    menu: "Masala Chai",
    base: { milk: 0.1, tea: 0.005, sugar: 0.01 },
    variants: { Large: { milk: 0.18, tea: 0.008, sugar: 0.016 } },
  },
  {
    menu: "Filter Coffee",
    base: { milk: 0.1, coffee: 0.008, sugar: 0.01 },
    variants: { Large: { milk: 0.18, coffee: 0.012, sugar: 0.016 } },
  },
  { menu: "Badam Milk", base: { milk: 0.2, almond: 0.01, sugar: 0.02 } },
  { menu: "Cold Coffee", base: { milk: 0.25, coffee: 0.01, sugar: 0.025 } },
  {
    menu: "Fresh Lime Soda",
    base: { lemon: 1, soda: 0.4 },
    variants: { Sweet: { lemon: 1, soda: 0.4, sugar: 0.025 }, Mixed: { lemon: 1, soda: 0.4, sugar: 0.015 } },
  },
  { menu: "Mango Lassi", base: { curd: 0.15, mango: 0.08, sugar: 0.02 } },
  { menu: "Samosa (2 pcs)", base: { sheets: 0.08, potato: 0.12, oil: 0.03 } },
  { menu: "Vada Pav", base: { pav: 0.167, potato: 0.1, besan: 0.02, oil: 0.025 } },
  { menu: "Onion Pakoda", base: { onion: 0.12, besan: 0.06, oil: 0.04 } },
  { menu: "Veg Sandwich", base: { bread: 0.2, veg: 0.06, butter: 0.01, cheese: 0.1 } },
  { menu: "Egg Puff", base: { puff: 0.1, eggs: 1, onion: 0.02 } },
  { menu: "Chicken Puff", base: { puff: 0.1, chicken: 0.04, onion: 0.02 } },
  { menu: "Masala Dosa", base: { batter: 0.15, potato: 0.1, onion: 0.03, oil: 0.015 } },
  { menu: "Idli Vada", base: { batter: 0.18, oil: 0.03 } },
  { menu: "Veg Thali", base: { rice: 0.15, atta: 0.08, veg: 0.12, curd: 0.08, oil: 0.03 } },
  {
    menu: "Chicken Biryani",
    base: { rice: 0.15, chicken: 0.15, onion: 0.06, oil: 0.03, curd: 0.03 },
    variants: { Full: { rice: 0.25, chicken: 0.25, onion: 0.1, oil: 0.05, curd: 0.05 } },
  },
  { menu: "Veg Fried Rice", base: { rice: 0.15, veg: 0.08, oil: 0.025 } },
  { menu: "Paneer Butter Masala + 2 Roti", base: { paneer: 0.12, butter: 0.015, tomato: 0.1, onion: 0.05, atta: 0.08 } },
  { menu: "Snack Combo (Samosa + Chai)", base: { sheets: 0.08, potato: 0.12, oil: 0.03, milk: 0.1, tea: 0.005, sugar: 0.01 } },
  { menu: "Mini Meal + Lassi", base: { rice: 0.12, veg: 0.1, curd: 0.2, mango: 0.05, sugar: 0.02 } },
  { menu: "Gulab Jamun (2 pcs)", base: { gjmix: 0.1, sugar: 0.04, oil: 0.02 } },
  { menu: "Kulfi", base: { kulfi: 1 } },
];

/** Demo data for the inventory module. Must be idempotent (skip if already seeded). */
export async function seedInventory(prisma: PrismaClient): Promise<void> {
  if (await prisma.inventoryItem.count()) {
    console.info("Inventory already seeded — skipping.");
    return;
  }
  const businessId = (await prisma.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } })).id;
  const outlets = await prisma.outlet.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
  if (!outlets.length) return;
  const admin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, orderBy: { createdAt: "asc" } });

  await prisma.$transaction(
    async (tx) => {
      const ids: Record<string, string> = {};
      const items: Record<string, { id: string; cost: number }> = {};
      for (const s of ITEMS) {
        const item = await tx.inventoryItem.create({
          data: {
            businessId,
            name: s.name,
            category: s.category,
            unit: s.unit,
            costPerUnit: rs(s.cost),
            reorderLevel: s.reorder,
            reorderQty: s.reorderQty,
            sku: s.sku,
            barcode: s.barcode,
          },
        });
        ids[s.key] = item.id;
        items[s.key] = { id: item.id, cost: rs(s.cost) };
      }

      // Opening stock for every outlet (OPENING ledger entries keep balanceAfter consistent).
      for (const outlet of outlets) {
        for (const s of ITEMS) {
          await tx.inventoryStock.create({ data: { outletId: outlet.id, inventoryItemId: ids[s.key], quantity: s.opening } });
          await tx.inventoryTransaction.create({
            data: {
              outletId: outlet.id,
              inventoryItemId: ids[s.key],
              type: "OPENING",
              quantity: s.opening,
              unitCost: rs(s.cost),
              balanceAfter: s.opening,
              refType: "Manual",
              note: "Opening stock (seed)",
              createdById: admin?.id,
            },
          });
        }
      }

      // Recipes for seeded menu items, looked up by name.
      const menu = await tx.menuItem.findMany({ include: { variants: true } });
      let recipeRows = 0;
      for (const r of RECIPES) {
        const m = menu.find((x) => x.name === r.menu);
        if (!m) continue;
        const rows: { menuItemId: string; variantId: string | null; inventoryItemId: string; quantity: number }[] = [];
        for (const [k, q] of Object.entries(r.base ?? {})) rows.push({ menuItemId: m.id, variantId: null, inventoryItemId: ids[k], quantity: q });
        for (const [vName, lines] of Object.entries(r.variants ?? {})) {
          const v = m.variants.find((x) => x.name === vName);
          if (!v) continue;
          for (const [k, q] of Object.entries(lines)) rows.push({ menuItemId: m.id, variantId: v.id, inventoryItemId: ids[k], quantity: q });
        }
        await tx.recipe.createMany({ data: rows });
        recipeRows += rows.length;
      }

      const [dairy, grocer, veggies] = await Promise.all([
        tx.vendor.create({
          data: { businessId, name: "Nandini Milk Distributors", contactPerson: "Suresh Gowda", phone: "9845011111", gstin: "29AAACN1234B1Z2", address: "Koramangala, Bengaluru", notes: "Daily 6 AM delivery" },
        }),
        tx.vendor.create({
          data: { businessId, name: "Sri Lakshmi Traders", contactPerson: "Ramesh Shetty", phone: "9845022222", gstin: "29AAGFS5678C1Z9", address: "KR Market, Bengaluru", notes: "Grocery wholesale, 15-day credit" },
        }),
        tx.vendor.create({
          data: { businessId, name: "Green Basket Vegetables", contactPerson: "Mohammed Irfan", phone: "9845033333", address: "Madiwala Market, Bengaluru", notes: "Cash on delivery" },
        }),
      ]);

      // Two received purchases at the first outlet: stock up and weighted-average cost update.
      const outlet = outlets[0];
      const purchases = [
        { vendorId: dairy.id, invoiceNo: "NMD-2291", paid: true, lines: [["milk", 30, 54, 0], ["paneer", 4, 370, 5], ["curd", 10, 68, 0]] as const },
        { vendorId: grocer.id, invoiceNo: "SLT-0874", paid: false, lines: [["sugar", 25, 42, 5], ["oil", 15, 150, 5], ["rice", 25, 105, 5], ["tea", 2, 470, 5]] as const },
      ];
      for (const p of purchases) {
        const lines = p.lines.map(([k, q, cost, tax]) => {
          const net = Math.round(q * rs(cost));
          const t = Math.round((net * tax) / 100);
          return { key: k, inventoryItemId: ids[k], quantity: q, unitCost: rs(cost), taxRate: tax, net, tax: t, total: net + t };
        });
        const subtotal = lines.reduce((s, l) => s + l.net, 0);
        const tax = lines.reduce((s, l) => s + l.tax, 0);
        const purchase = await tx.purchase.create({
          data: {
            outletId: outlet.id,
            vendorId: p.vendorId,
            invoiceNo: p.invoiceNo,
            invoiceDate: new Date().toISOString().slice(0, 10),
            status: "RECEIVED",
            subtotal,
            tax,
            total: subtotal + tax,
            paidAmount: p.paid ? subtotal + tax : 0,
            createdById: admin?.id,
            receivedAt: new Date(),
            items: { create: lines.map(({ inventoryItemId, quantity, unitCost, taxRate, total }) => ({ inventoryItemId, quantity, unitCost, taxRate, total })) },
            // A paid purchase has its payment row, like one paid in the app (QA Phase 7 reconciliation B08).
            ...(p.paid && { payments: { create: [{ amount: subtotal + tax, mode: "BANK", reference: "Seed", createdById: admin?.id }] } }),
          },
        });
        for (const l of lines) {
          const landed = l.total / l.quantity;
          const stocks = await tx.inventoryStock.findMany({ where: { inventoryItemId: l.inventoryItemId } });
          const existing = stocks.reduce((s, x) => s + Math.max(0, x.quantity), 0);
          const cost = Math.round((existing * items[l.key].cost + l.quantity * landed) / (existing + l.quantity));
          items[l.key].cost = cost;
          await tx.inventoryItem.update({ where: { id: l.inventoryItemId }, data: { costPerUnit: cost } });
          const stock = await tx.inventoryStock.update({
            where: { outletId_inventoryItemId: { outletId: outlet.id, inventoryItemId: l.inventoryItemId } },
            data: { quantity: { increment: l.quantity } },
          });
          await tx.inventoryTransaction.create({
            data: {
              outletId: outlet.id,
              inventoryItemId: l.inventoryItemId,
              type: "PURCHASE",
              quantity: l.quantity,
              unitCost: Math.round(landed),
              balanceAfter: r3(stock.quantity),
              refType: "Purchase",
              refId: purchase.id,
              note: p.invoiceNo,
              createdById: admin?.id,
            },
          });
        }
      }
      console.info(
        `Seeded inventory: ${ITEMS.length} items × ${outlets.length} outlet(s), ${recipeRows} recipe lines, 3 vendors (${veggies.name} etc.), 2 purchases.`,
      );
    },
    { timeout: 60_000 },
  );
}
