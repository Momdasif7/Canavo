// Background jobs for the CRM module: birthday/anniversary wishes with an
// auto-coupon, and loyalty points expiry. Runs hourly; does its work once per
// local day per business (tracked in Setting <businessId>/"crm.dailyRun.lastDate").
import { randomBytes } from "node:crypto";
import type { Customer } from "@prisma/client";
import { formatINR } from "@canavo/shared";
import { platformPrisma, prisma } from "./db";
import { requireBusinessId, runForBusiness } from "./lib/tenant";
import { registerJob } from "./jobs";
import { zonedParts } from "./lib/time";
import { CRM_TEMPLATES, sendCustomerMessage } from "./services/customer-messages";
import { notify, outletManagers } from "./services/notify";
import { getLoyaltyConfig } from "./services/promotions";

const dailyKey = () => ({ scope: requireBusinessId(), key: "crm.dailyRun.lastDate" });
/** Don't send wishes before this local hour */
const SEND_AFTER_HOUR = 9;

export function registerJobs(): void {
  registerJob("crm-daily", 60 * 60 * 1000, async () => {
    await runCrmDaily();
  });
  // First check shortly after boot instead of waiting an hour.
  setTimeout(() => runCrmDaily().catch((e) => console.error("[job:crm-daily]", e)), 60_000).unref();
}

/** Run the daily CRM work for every active business, each inside its own tenant context. */
export async function runCrmDaily(now = new Date(), opts: { force?: boolean } = {}) {
  const businesses = await platformPrisma.business.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const results = [];
  for (const b of businesses) results.push(await runForBusiness(b.id, () => runCrmDailyForBusiness(now, opts)));
  return results;
}

export async function runCrmDailyForBusiness(now: Date, opts: { force?: boolean }) {
  const DAILY_KEY = dailyKey();
  const outlet = await prisma.outlet.findFirst({ orderBy: { createdAt: "asc" }, select: { timezone: true, name: true } });
  if (!outlet) return null;
  const local = zonedParts(now, outlet.timezone);
  if (!opts.force && local.minutes < SEND_AFTER_HOUR * 60) return null;

  const last = await prisma.setting.findUnique({ where: { scope_key: DAILY_KEY } });
  if (!opts.force && last?.value === local.date) return null;
  // Claim the day first so a crash mid-run doesn't double-send tomorrow's retry.
  await prisma.setting.upsert({
    where: { scope_key: DAILY_KEY },
    create: { ...DAILY_KEY, value: local.date },
    update: { value: local.date },
  });

  const celebrations = await sendCelebrations(now, local.date, outlet.name);
  const expired = await expirePoints(now);
  console.info(
    `[crm] daily run ${local.date}: ${celebrations.length} wishes, ${expired.customers} customers / ${expired.points} points expired`,
  );
  return { date: local.date, celebrations, expired };
}

async function uniqueCode(prefix: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = `${prefix}-${randomBytes(3).toString("hex").slice(0, 4).toUpperCase()}`;
    if (!(await prisma.coupon.findFirst({ where: { code } }))) return code;
  }
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

async function sendCelebrations(now: Date, ymd: string, brand: string) {
  const mmdd = ymd.slice(5);
  const cfg = await getLoyaltyConfig();
  const customers = await prisma.customer.findMany({
    where: { blocked: false, OR: [{ birthday: mmdd }, { anniversary: mmdd }] },
  });
  const results: { customerId: string; phone: string; occasion: string; code: string | null; method: string; waLink: string }[] = [];
  for (const c of customers) {
    for (const occasion of ["birthday", "anniversary"] as const) {
      if (c[occasion] !== mmdd) continue;
      results.push(await wish(c, occasion, now, brand, cfg));
    }
  }
  if (results.length) {
    const outlets = await prisma.outlet.findMany({ select: { id: true } });
    const managers = new Set<string>();
    for (const o of outlets) (await outletManagers(o.id)).forEach((id) => managers.add(id));
    const names = customers.map((c) => c.name ?? c.phone).slice(0, 10).join(", ");
    await notify(
      [...managers],
      `${results.length} customer celebration${results.length > 1 ? "s" : ""} today`,
      `Wishes${cfg.birthdayCouponEnabled ? " + 7-day coupons" : ""} sent to ${names}${customers.length > 10 ? "…" : ""}. ` +
        `${results.filter((r) => r.method === "link").length} need a WhatsApp tap (see audit log for links).`,
      "crm.celebration",
    );
  }
  return results;
}

async function wish(
  c: Customer,
  occasion: "birthday" | "anniversary",
  now: Date,
  brand: string,
  cfg: Awaited<ReturnType<typeof getLoyaltyConfig>>,
) {
  let code: string | null = null;
  let offerText = "";
  if (cfg.birthdayCouponEnabled) {
    // A config saved before the 100 % cap (QA Phase 7, D4) must not make a coupon worth more than the bill.
    const couponValue = cfg.birthdayCouponType === "PERCENT" ? Math.min(cfg.birthdayCouponValue, 100) : cfg.birthdayCouponValue;
    code = await uniqueCode(occasion === "birthday" ? "BDAY" : "ANNV");
    await prisma.coupon.create({
      data: {
        businessId: c.businessId,
        code,
        description: `${occasion === "birthday" ? "Birthday" : "Anniversary"} coupon for ${c.name ?? ""} ${c.phone}`.replace(/\s+/g, " "),
        discountType: cfg.birthdayCouponType,
        value: couponValue,
        maxDiscount: cfg.birthdayCouponType === "PERCENT" ? cfg.birthdayCouponMaxDiscount : null,
        usageLimit: 1,
        perCustomerLimit: 1,
        customerId: c.id,
        startsAt: now,
        expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      },
    });
    const value =
      cfg.birthdayCouponType === "PERCENT" ? `${couponValue}% off` : `${formatINR(couponValue)} off`;
    offerText = ` Enjoy ${value} on your next visit with code ${code} (valid 7 days).`;
  }
  const greeting = occasion === "birthday" ? "Happy Birthday" : "Happy Anniversary";
  const text = `${greeting}, ${c.name ?? "dear customer"}! 🎉 Warm wishes from ${brand}.${offerText}`;
  const result = await sendCustomerMessage({
    phone: c.phone,
    text,
    template: occasion === "birthday" ? CRM_TEMPLATES.birthday : CRM_TEMPLATES.anniversary,
    broadcast: `${occasion}_${now.toISOString().slice(0, 10)}`,
    parameters: [
      { name: "name", value: c.name ?? "Customer" },
      { name: "outlet", value: brand },
      { name: "code", value: code ?? "" },
    ],
  });
  await prisma.auditLog.create({
    data: {
      action: `crm.${occasion}_wish`,
      entity: "Customer",
      entityId: c.id,
      meta: { code, method: result.method, waLink: result.waLink },
    },
  });
  if (result.method === "link") console.info(`[crm] ${occasion} wish for ${c.phone}: ${result.waLink}`);
  return { customerId: c.id, phone: c.phone, occasion, code, method: result.method, waLink: result.waLink };
}

/**
 * Expire points earned before the cutoff that haven't been used since:
 *   expire = min(balance, credits before cutoff − all debits so far)
 * (credits = EARN / positive ADJUST / positive REVERSE; debits = REDEEM,
 * EXPIRE, negative ADJUST / REVERSE). FIFO approximation.
 */
export async function expirePoints(now = new Date()) {
  const cfg = await getLoyaltyConfig();
  if (!cfg.pointsExpiryMonths) return { customers: 0, points: 0 };
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - cfg.pointsExpiryMonths);

  const [credits, debits] = await Promise.all([
    prisma.loyaltyTransaction.groupBy({
      by: ["customerId"],
      where: { points: { gt: 0 }, createdAt: { lt: cutoff }, customer: { points: { gt: 0 } } },
      _sum: { points: true },
    }),
    prisma.loyaltyTransaction.groupBy({
      by: ["customerId"],
      where: { points: { lt: 0 }, customer: { points: { gt: 0 } } },
      _sum: { points: true },
    }),
  ]);
  const debitBy = new Map(debits.map((d) => [d.customerId, -(d._sum.points ?? 0)]));
  let customers = 0;
  let total = 0;
  for (const cr of credits) {
    const stale = (cr._sum.points ?? 0) - (debitBy.get(cr.customerId) ?? 0);
    if (stale <= 0) continue;
    await prisma.$transaction(async (tx) => {
      const c = await tx.customer.findUniqueOrThrow({ where: { id: cr.customerId }, select: { points: true } });
      const n = Math.min(stale, c.points);
      if (n <= 0) return;
      await tx.loyaltyTransaction.create({
        data: { customerId: cr.customerId, type: "EXPIRE", points: -n, note: `Expired: earned before ${cutoff.toISOString().slice(0, 10)}` },
      });
      await tx.customer.update({ where: { id: cr.customerId }, data: { points: { decrement: n } } });
      customers++;
      total += n;
    });
  }
  return { customers, points: total };
}
