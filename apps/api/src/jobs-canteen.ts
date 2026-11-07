// Background job for the canteen module (Phase 5.4): turn subscription meals into the day's
// pre-orders once each slot's pre-order cutoff passes, so the kitchen gets KOTs.
import { platformPrisma, prisma } from "./db";
import { registerJob } from "./jobs";
import { runForBusiness } from "./lib/tenant";
import { materialiseOutlet } from "./services/canteen-meals";

/** Every business with CANTEEN: materialise due meals for each of its outlets. */
export async function materialiseSubscriptionMeals(now = new Date()) {
  const businesses = await platformPrisma.business.findMany({ where: { status: "ACTIVE", modules: { has: "CANTEEN" } }, select: { id: true } });
  let created = 0;
  for (const b of businesses) {
    created += await runForBusiness(b.id, async () => {
      let n = 0;
      for (const o of await prisma.outlet.findMany({ select: { id: true } })) n += await materialiseOutlet(o.id, now);
      return n;
    });
  }
  if (created) console.info(`[job:canteen-meals] made ${created} subscription meal pre-order(s)`);
  return created;
}

export function registerJobs(): void {
  registerJob("canteen-meals", 5 * 60_000, async () => {
    await materialiseSubscriptionMeals();
  });
}
