import type { LoyaltyTier, PrismaClient } from "@prisma/client";

const rs = (n: number) => Math.round(n * 100);

/** Demo data for the CRM module. Idempotent: customers by phone, offers by name, coupons by code. */
export async function seedCrm(prisma: PrismaClient): Promise<void> {
  const businessId = (await prisma.business.findFirstOrThrow({ orderBy: { createdAt: "asc" } })).id;
  const outlet = await prisma.outlet.findFirst({ orderBy: { createdAt: "asc" } });
  if (!outlet) return;

  // "Today" in outlet time, for the birthday customer.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone, month: "2-digit", day: "2-digit" })
    .format(new Date())
    .replace("/", "-");
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  type C = {
    phone: string; name: string; spend: number; visits: number; points: number; tier: LoyaltyTier; last: number;
    birthday?: string; anniversary?: string; khata?: number; khataLimit?: number; blocked?: boolean; notes?: string; email?: string;
  };
  const customers: C[] = [
    { phone: "9845010001", name: "Priya Sharma", spend: 52_400, visits: 210, points: 1820, tier: "PLATINUM", last: 1, birthday: "03-14", email: "priya@example.com" },
    { phone: "9845010002", name: "Rahul Verma", spend: 23_150, visits: 120, points: 940, tier: "GOLD", last: 2, anniversary: "11-20" },
    { phone: "9845010003", name: "Ananya Iyer", spend: 16_800, visits: 95, points: 610, tier: "GOLD", last: 0, birthday: today },
    { phone: "9845010004", name: "Vikram Rao", spend: 9_200, visits: 60, points: 420, tier: "SILVER", last: 3, khata: 640, khataLimit: 2000, notes: "Works at the IT park, settles monthly" },
    { phone: "9845010005", name: "Sneha Kulkarni", spend: 7_450, visits: 48, points: 305, tier: "SILVER", last: 5 },
    { phone: "9845010006", name: "Arjun Nair", spend: 5_600, visits: 40, points: 150, tier: "SILVER", last: 9, khata: 1_250, khataLimit: 1500 },
    { phone: "9845010007", name: "Meera Joshi", spend: 4_100, visits: 33, points: 260, tier: "BRONZE", last: 4, birthday: "07-02" },
    { phone: "9845010008", name: "Karthik Reddy", spend: 3_350, visits: 25, points: 120, tier: "BRONZE", last: 12 },
    { phone: "9845010009", name: "Fatima Sheikh", spend: 2_800, visits: 22, points: 95, tier: "BRONZE", last: 7 },
    { phone: "9845010010", name: "Rohan Das", spend: 1_900, visits: 14, points: 190, tier: "BRONZE", last: 20 },
    { phone: "9845010011", name: "Divya Menon", spend: 1_250, visits: 9, points: 60, tier: "BRONZE", last: 31 },
    { phone: "9845010012", name: "Sanjay Gupta", spend: 850, visits: 6, points: 85, tier: "BRONZE", last: 45, blocked: true, notes: "Blocked: repeated unpaid khata" },
    { phone: "9845010013", name: "Lakshmi Pillai", spend: 640, visits: 4, points: 64, tier: "BRONZE", last: 60 },
    { phone: "9845010014", name: "Imran Khan", spend: 320, visits: 2, points: 32, tier: "BRONZE", last: 90 },
    { phone: "9845010015", name: "Neha Agarwal", spend: 120, visits: 1, points: 12, tier: "BRONZE", last: 15 },
  ];
  let created = 0;
  for (const c of customers) {
    if (await prisma.customer.findFirst({ where: { businessId, phone: c.phone } })) continue;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        phone: c.phone,
        name: c.name,
        email: c.email,
        birthday: c.birthday,
        anniversary: c.anniversary,
        totalSpend: rs(c.spend),
        visitCount: c.visits,
        lastVisitAt: daysAgo(c.last),
        points: c.points,
        tier: c.tier,
        khataBalance: rs(c.khata ?? 0),
        khataLimit: rs(c.khataLimit ?? 0),
        blocked: c.blocked ?? false,
        notes: c.notes,
        createdAt: daysAgo(400),
      },
    });
    // Ledger that sums to the balance: earned points spread over time, one redemption for regulars.
    const redeemed = c.points >= 500 ? 200 : 0;
    await prisma.loyaltyTransaction.createMany({
      data: [
        { customerId: customer.id, type: "EARN" as const, points: Math.ceil((c.points + redeemed) / 2), note: "Opening balance (migrated)", createdAt: daysAgo(120) },
        { customerId: customer.id, type: "EARN" as const, points: Math.floor((c.points + redeemed) / 2), note: "Opening balance (migrated)", createdAt: daysAgo(30) },
        ...(redeemed ? [{ customerId: customer.id, type: "REDEEM" as const, points: -redeemed, note: "Redeemed at counter", createdAt: daysAgo(10) }] : []),
      ],
    });
    if (c.khata) {
      await prisma.khataTransaction.createMany({
        data: [
          { customerId: customer.id, outletId: outlet.id, type: "DEBIT" as const, amount: rs(c.khata + 300), mode: "KHATA", note: "Opening dues", createdAt: daysAgo(20) },
          { customerId: customer.id, outletId: outlet.id, type: "CREDIT" as const, amount: rs(300), mode: "UPI", note: "Part payment", createdAt: daysAgo(8) },
        ],
      });
    }
    created++;
  }

  // ---------- Offers ----------
  const item = async (name: string) => (await prisma.menuItem.findFirst({ where: { name } }))?.id;
  const category = async (name: string) => (await prisma.menuCategory.findFirst({ where: { name } }))?.id;
  const [hot, samosa, chai, vadaPav] = await Promise.all([
    category("Hot Beverages"),
    item("Samosa (2 pcs)"),
    item("Masala Chai"),
    item("Vada Pav"),
  ]);
  const offers = [
    hot && {
      name: "Happy Hour: 20% off Hot Beverages",
      type: "HAPPY_HOUR" as const,
      startTime: "15:00",
      endTime: "17:00",
      priority: 10,
      config: { target: { categoryIds: [hot] }, discountType: "PERCENT", value: 20 },
    },
    samosa && chai && {
      name: "Buy 2 Samosa, get 1 Chai free",
      type: "BUY_X_GET_Y" as const,
      priority: 5,
      config: { buy: { menuItemIds: [samosa], quantity: 2 }, get: { menuItemIds: [chai], quantity: 1 }, getDiscountPercent: 100 },
    },
    vadaPav && chai && {
      name: "Combo: Vada Pav + Masala Chai ₹35",
      type: "COMBO" as const,
      priority: 4,
      config: { items: [{ menuItemId: vadaPav, quantity: 1 }, { menuItemId: chai, quantity: 1 }], price: rs(35) },
    },
    {
      name: "10% off bills over ₹500",
      type: "BILL_DISCOUNT" as const,
      priority: 0,
      config: { minOrder: rs(500), discountType: "PERCENT", value: 10, maxDiscount: rs(100) },
    },
  ].filter(Boolean) as { name: string; type: "HAPPY_HOUR" | "BUY_X_GET_Y" | "COMBO" | "BILL_DISCOUNT"; priority: number; startTime?: string; endTime?: string; config: object }[];
  for (const o of offers) {
    if (await prisma.offer.findFirst({ where: { businessId, name: o.name } })) continue;
    await prisma.offer.create({ data: { ...o, businessId, outletIds: [], daysOfWeek: [] } });
  }

  // ---------- Coupons ----------
  const coupons = [
    { code: "WELCOME50", description: "₹50 off your first order over ₹200", discountType: "FLAT" as const, value: rs(50), minOrder: rs(200), perCustomerLimit: 1 },
    { code: "FEST10", description: "Festive season: 10% off (max ₹75)", discountType: "PERCENT" as const, value: 10, maxDiscount: rs(75), minOrder: 0 },
  ];
  for (const c of coupons) {
    await prisma.coupon.upsert({ where: { businessId_code: { businessId, code: c.code } }, update: {}, create: { ...c, businessId } });
  }

  console.info(`CRM seed: ${created} new customers, ${offers.length} offers, ${coupons.length} coupons checked.`);
}
