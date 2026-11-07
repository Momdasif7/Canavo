import { PrismaClient, FoodType } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedInventory } from "./seed-inventory";
import { seedService } from "./seed-service";
import { seedCrm } from "./seed-crm";
import { seedPlatform } from "./seed-platform";

/**
 * The seed is platform work: like the platform client (src/db.ts) it bypasses row-level security.
 * Needed whenever the database role isn't a superuser (Render / Neon owners): FORCE RLS binds them,
 * and without the setting every read sees no rows and every insert is refused.
 */
function seedUrl(raw = process.env.DATABASE_URL) {
  if (!raw) return undefined;
  const u = new URL(raw);
  const options = [u.searchParams.get("options"), "-c app.bypass_rls=on"].filter(Boolean).join(" ");
  u.searchParams.delete("options");
  return `${u.toString()}${u.search ? "&" : "?"}options=${encodeURIComponent(options)}`;
}
const url = seedUrl();
const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
const rs = (n: number) => Math.round(n * 100);

async function main() {
  // The demo seed creates logins with a published password: never in production.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "1") {
    console.error("Refusing to seed demo data in production (it creates demo logins with a known password). Set ALLOW_DEMO_SEED=1 only for a throwaway demo environment.");
    process.exit(1);
  }
  if (await prisma.outlet.count()) {
    console.info("Base data already seeded — skipping.");
  } else {
    await seedBase();
  }
  // Module seeds are individually idempotent.
  await seedInventory(prisma);
  await seedService(prisma);
  await seedCrm(prisma);
  await seedPlatform(prisma);
  await ensureDemoOwner();
  await ensureDemoRoles();
}

/** One demo login for each role added after the base seed (idempotent, also added to existing databases). */
async function ensureDemoRoles() {
  const outlet = await prisma.outlet.findFirst({ where: { businessId: DEMO_BUSINESS_ID }, orderBy: { createdAt: "asc" } });
  if (!outlet) return;
  const roles = [
    { name: "Wasim Waiter", phone: "9876500007", email: "waiter@canavo.local", role: "WAITER" as const },
    { name: "Anita Accountant", phone: "9876500008", email: "accountant@canavo.local", role: "ACCOUNTANT" as const },
    { name: "Arjun Auditor", phone: "9876500009", email: "auditor@canavo.local", role: "AUDITOR" as const },
  ];
  let password: string | undefined;
  for (const r of roles) {
    if (await prisma.user.findUnique({ where: { phone: r.phone } })) continue;
    password ??= await bcrypt.hash("Canavo@123", 10);
    await prisma.user.create({ data: { ...r, businessId: DEMO_BUSINESS_ID, passwordHash: password, outlets: { create: { outletId: outlet.id } } } });
    console.info(`Demo ${r.role.toLowerCase()}: ${r.email} / Canavo@123`);
  }
  // Platform support: a platform login (no business), like the super admin.
  if (!(await prisma.user.findUnique({ where: { phone: "9876500010" } }))) {
    await prisma.user.create({
      data: { name: "Sana Support", phone: "9876500010", email: "support@canavo.local", role: "PLATFORM_SUPPORT", passwordHash: password ?? (await bcrypt.hash("Canavo@123", 10)) },
    });
    console.info("Demo platform support: support@canavo.local / Canavo@123");
  }
}

/** A business-owner login for the demo business (idempotent, also added to existing databases). */
async function ensureDemoOwner() {
  if (await prisma.user.findUnique({ where: { phone: "9876500005" } })) return;
  await prisma.user.create({
    data: {
      businessId: DEMO_BUSINESS_ID,
      role: "BUSINESS_OWNER",
      name: "Omkar Owner",
      phone: "9876500005",
      email: "owner@canavo.local",
      passwordHash: await bcrypt.hash("Canavo@123", 10),
    },
  });
  console.info("Demo business owner: owner@canavo.local / Canavo@123");
}

const DEMO_BUSINESS_ID = "biz_demo";
const ALL_MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS"];

async function seedBase() {
  const businessId = DEMO_BUSINESS_ID;
  // The multi-business migration already inserts the demo business and its GST rates; upsert so a fresh DB seeds cleanly.
  await prisma.business.upsert({
    where: { id: businessId },
    // The demo hotel shows off flagged features; real hotels start with every flag off.
    create: { id: businessId, name: "Demo Hotel", ownerName: "Omkar Owner", modules: ALL_MODULES, features: { AUTO_STOCK_OUT: true } },
    update: { ownerName: "Omkar Owner", modules: ALL_MODULES },
  });
  for (const [rate, name] of [[0, "GST 0% (Exempt)"], [5, "GST 5%"], [12, "GST 12%"], [18, "GST 18%"], [28, "GST 28%"]] as const) {
    await prisma.taxRate.upsert({
      where: { id: `tax_demo_${rate}` },
      create: { id: `tax_demo_${rate}`, businessId, name, cgst: rate / 2, sgst: rate / 2, igst: rate, isDefault: rate === 5 },
      update: {},
    });
  }

  const outlet = await prisma.outlet.create({
    data: {
      businessId,
      name: "CANAVO Canteen",
      address: "80 Feet Road, Koramangala 4th Block, Bengaluru 560034",
      stateCode: "29",
      gstin: "29ABCDE1234F1Z5",
      fssai: "11224999000123",
      phone: "080-40001234",
      latitude: 12.9352,
      longitude: 77.6245,
      geofenceMeters: 200,
      invoicePrefix: "INV",
      pricesIncludeTax: true,
      upiVpa: "canavo@okaxis",
    },
  });

  const [morning, evening] = await Promise.all([
    prisma.shift.create({ data: { outletId: outlet.id, name: "Morning", startTime: "07:00", endTime: "15:00", graceMinutes: 10 } }),
    prisma.shift.create({ data: { outletId: outlet.id, name: "Evening", startTime: "15:00", endTime: "23:00", graceMinutes: 10 } }),
    prisma.shift.create({ data: { outletId: outlet.id, name: "Night", startTime: "23:00", endTime: "07:00", graceMinutes: 10 } }),
  ]);

  const password = await bcrypt.hash("Canavo@123", 10);
  const pin = await bcrypt.hash("1234", 10);
  const staff = [
    { name: "Asha Admin", phone: "9876500000", email: "admin@canavo.local", role: "SUPER_ADMIN" as const, salaryType: "MONTHLY" as const, salaryAmount: rs(60000) },
    { name: "Manoj Manager", phone: "9876500001", email: "manager@canavo.local", role: "OUTLET_MANAGER" as const, salaryType: "MONTHLY" as const, salaryAmount: rs(35000), shiftId: morning.id },
    { name: "Kavya Cashier", phone: "9876500002", email: "cashier@canavo.local", role: "CASHIER" as const, salaryType: "MONTHLY" as const, salaryAmount: rs(18000), shiftId: morning.id },
    { name: "Ravi Cook", phone: "9876500003", email: "kitchen@canavo.local", role: "KITCHEN" as const, salaryType: "DAILY" as const, salaryAmount: rs(800), shiftId: morning.id },
    { name: "Isha Inventory", phone: "9876500006", email: "inventory@canavo.local", role: "INVENTORY_MANAGER" as const, salaryType: "MONTHLY" as const, salaryAmount: rs(20000), shiftId: morning.id },
    { name: "Deepak Delivery", phone: "9876500004", email: "delivery@canavo.local", role: "DELIVERY" as const, salaryType: "DAILY" as const, salaryAmount: rs(700), shiftId: evening.id },
  ];
  for (const s of staff) {
    await prisma.user.create({
      // The super admin is the platform operator (no business); everyone else belongs to the demo business.
      data:
        s.role === "SUPER_ADMIN"
          ? { ...s, passwordHash: password }
          : { ...s, businessId, passwordHash: password, pinHash: pin, outlets: { create: { outletId: outlet.id } } },
    });
  }

  const cat = async (name: string, sortOrder: number, parentId?: string) =>
    (await prisma.menuCategory.create({ data: { businessId, name, sortOrder, parentId } })).id;
  const beverages = await cat("Beverages", 1);
  const hot = await cat("Hot Beverages", 1, beverages);
  const cold = await cat("Cold Beverages", 2, beverages);
  const snacks = await cat("Snacks", 2);
  const meals = await cat("Meals", 3);
  const combos = await cat("Combos", 4);
  const desserts = await cat("Desserts", 5);

  type Seed = {
    name: string; categoryId: string; price: number; foodType?: FoodType; gstRate?: number; station?: string;
    from?: string; to?: string; variants?: [string, number][]; addons?: [string, number][]; description?: string; hsn?: string;
  };
  const items: Seed[] = [
    { name: "Masala Chai", categoryId: hot, price: 15, station: "BEVERAGE", variants: [["Regular", 15], ["Large", 25]] },
    { name: "Filter Coffee", categoryId: hot, price: 20, station: "BEVERAGE", variants: [["Regular", 20], ["Large", 30]] },
    { name: "Badam Milk", categoryId: hot, price: 35, station: "BEVERAGE" },
    { name: "Cold Coffee", categoryId: cold, price: 60, station: "BEVERAGE", addons: [["Ice cream scoop", 20]] },
    { name: "Fresh Lime Soda", categoryId: cold, price: 40, station: "BEVERAGE", variants: [["Sweet", 40], ["Salted", 40], ["Mixed", 45]] },
    { name: "Mango Lassi", categoryId: cold, price: 50, station: "BEVERAGE" },
    { name: "Samosa (2 pcs)", categoryId: snacks, price: 30 },
    { name: "Vada Pav", categoryId: snacks, price: 25, addons: [["Extra cheese", 20]] },
    { name: "Onion Pakoda", categoryId: snacks, price: 40 },
    { name: "Veg Sandwich", categoryId: snacks, price: 50, addons: [["Extra cheese", 20], ["No onion", 0]] },
    { name: "Egg Puff", categoryId: snacks, price: 30, foodType: "EGG" },
    { name: "Chicken Puff", categoryId: snacks, price: 40, foodType: "NON_VEG" },
    // Packaged / exempt goods sold over the counter carry their own GST (not the 5% restaurant rate).
    { name: "Mineral Water (1 L)", categoryId: cold, price: 20, gstRate: 18, station: "BEVERAGE", hsn: "2201" },
    { name: "Packaged Namkeen", categoryId: snacks, price: 30, gstRate: 12, hsn: "2106" },
    { name: "Tender Coconut", categoryId: cold, price: 50, gstRate: 0, station: "BEVERAGE", hsn: "0801" },
    { name: "Masala Dosa", categoryId: meals, price: 60, from: "07:00", to: "11:30", description: "Breakfast only" },
    { name: "Idli Vada", categoryId: meals, price: 45, from: "07:00", to: "11:30", description: "Breakfast only" },
    { name: "Veg Thali", categoryId: meals, price: 110, from: "12:00", to: "15:30" },
    { name: "Chicken Biryani", categoryId: meals, price: 160, foodType: "NON_VEG", variants: [["Half", 160], ["Full", 260]] },
    { name: "Veg Fried Rice", categoryId: meals, price: 90 },
    { name: "Paneer Butter Masala + 2 Roti", categoryId: meals, price: 130 },
    { name: "Snack Combo (Samosa + Chai)", categoryId: combos, price: 40 },
    { name: "Mini Meal + Lassi", categoryId: combos, price: 99 },
    { name: "Gulab Jamun (2 pcs)", categoryId: desserts, price: 35 },
    { name: "Kulfi", categoryId: desserts, price: 40, station: "BEVERAGE" },
  ];
  for (const it of items) {
    await prisma.menuItem.create({
      data: {
        businessId,
        taxRateId: `tax_demo_${it.gstRate ?? 5}`,
        name: it.name,
        description: it.description ?? "",
        categoryId: it.categoryId,
        price: rs(it.price),
        foodType: it.foodType ?? "VEG",
        gstRate: it.gstRate ?? 5,
        hsnCode: it.hsn ?? "996331",
        allergens: [],
        kitchenStation: it.station ?? "MAIN",
        availableFrom: it.from,
        availableTo: it.to,
        variants: { create: (it.variants ?? []).map(([name, p]) => ({ name, price: rs(p) })) },
        addons: { create: (it.addons ?? []).map(([name, p]) => ({ name, price: rs(p) })) },
      },
    });
  }

  console.info(`Seeded outlet ${outlet.id} with ${staff.length} staff and ${items.length} menu items.`);
  console.info("Logins (password Canavo@123): admin@ / manager@ / cashier@ / kitchen@canavo.local — staff PIN 1234");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
