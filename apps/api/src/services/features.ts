import type { FeatureFlags } from "@canavo/shared";
import { platformPrisma } from "../db";
import { runForOutlet } from "../lib/tenant";
import { emitToOutlet } from "../realtime";
import { refreshMenuAvailability } from "./stock-availability";

/**
 * Apply side effects when the Super Admin flips a business's feature flags.
 * AUTO_STOCK_OUT on → compute availability now; off → clear every automatic flag
 * so all items are sellable again under the old rule.
 */
export async function onFeaturesChanged(businessId: string, before: FeatureFlags, after: FeatureFlags) {
  if (Boolean(before.AUTO_STOCK_OUT) !== Boolean(after.AUTO_STOCK_OUT)) {
    const outlets = await platformPrisma.outlet.findMany({ where: { businessId }, select: { id: true } });
    for (const o of outlets) {
      if (after.AUTO_STOCK_OUT) {
        await runForOutlet(o.id, async () => {
          const changed = await refreshMenuAvailability(platformPrisma, o.id);
          if (changed.length) emitToOutlet(o.id, "menu:changed", { ids: changed.map((c) => c.id), stock: true });
        });
      } else {
        await platformPrisma.outletItemOverride.updateMany({ where: { outletId: o.id }, data: { stockOut: false, stockOutVariantIds: [], stockOutReason: null } });
        emitToOutlet(o.id, "menu:changed", { stock: true });
      }
    }
  }
}
