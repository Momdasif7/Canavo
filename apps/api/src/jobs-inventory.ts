// Background jobs for the inventory module. Register with registerJob(name, everyMs, fn).
import { prisma } from "./db";
import { registerJob } from "./jobs";
import { moduleEnabled, runForOutlet } from "./lib/tenant";
import { zonedParts } from "./lib/time";
import { notify } from "./services/notify";
import { inventoryRecipients, lowStockItems } from "./services/inventory";

const DIGEST_KEY = "inventory.lowStockDigest.lastSent";
/** Local time (minutes after midnight) from which the daily digest may go out. */
const DIGEST_AFTER_MINUTES = 8 * 60;

/** Send each outlet's managers one low-stock digest per local day. Exported for manual runs/tests. */
export async function sendLowStockDigests(now = new Date()): Promise<number> {
  const outlets = await prisma.outlet.findMany({ select: { id: true, name: true, timezone: true } });
  let sent = 0;
  for (const outlet of outlets) {
    // Each outlet's digest runs inside its own business (and only if it has Inventory).
    const did = await runForOutlet(outlet.id, async () => {
      if (!moduleEnabled("INVENTORY")) return 0;
      return digestForOutlet(outlet, now);
    });
    sent += did;
  }
  return sent;
}

async function digestForOutlet(outlet: { id: string; name: string; timezone: string }, now: Date): Promise<number> {
  let sent = 0;
  {
    const { date, minutes } = zonedParts(now, outlet.timezone);
    if (minutes < DIGEST_AFTER_MINUTES) return 0;
    const last = await prisma.setting.findUnique({ where: { scope_key: { scope: outlet.id, key: DIGEST_KEY } } });
    if ((last?.value as { date?: string } | null)?.date === date) return 0;

    const low = await lowStockItems(outlet.id);
    if (low.length) {
      const lines = low
        .slice(0, 25)
        .map((i) => `${i.outOfStock ? "OUT" : "LOW"} ${i.name}: ${i.quantity} ${i.unit} (reorder ${i.suggestedOrderQty} ${i.unit})`);
      if (low.length > 25) lines.push(`…and ${low.length - 25} more`);
      await notify(
        await inventoryRecipients(outlet.id),
        `${outlet.name}: ${low.length} item(s) need reordering`,
        lines.join("\n"),
        "inventory.digest",
      );
      sent++;
    }
    const value = { date, items: low.length };
    await prisma.setting.upsert({
      where: { scope_key: { scope: outlet.id, key: DIGEST_KEY } },
      create: { scope: outlet.id, key: DIGEST_KEY, value },
      update: { value },
    });
  }
  return sent;
}

export function registerJobs(): void {
  registerJob("inventory:low-stock-digest", 60 * 60 * 1000, async () => {
    await sendLowStockDigests();
  });
}
