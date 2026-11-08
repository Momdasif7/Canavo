import { ApiError, endpoints, errorMessage } from "../lib/api";
import { listQueue, markCreated, markState, pruneQueue, type PendingOrder } from "../lib/db";

/** A bill the server rejects this many times is set aside as "failed" (the user can retry it). */
export const MAX_ATTEMPTS = 3;
/** Retry interval while bills are waiting… */
export const SYNC_INTERVAL_MS = 30_000;
/** …doubled after each failed run (server down, timeouts), up to this cap. */
export const SYNC_MAX_DELAY_MS = 5 * 60_000;

/** Delay before the next automatic sync after `failures` consecutive failed runs (0 = healthy). */
export function nextSyncDelay(failures: number): number {
  const n = Math.max(0, Math.min(failures, 10));
  return Math.min(SYNC_INTERVAL_MS * 2 ** n, SYNC_MAX_DELAY_MS);
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of arr) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
}

/**
 * One pass over the offline bill queue:
 * 1. create queued bills through POST /orders/sync (per outlet, ≤200 per call; idempotent on
 *    clientOrderId, so a bill the server already has comes back as the same order — no duplicate);
 * 2. record the counter payment for bills that now exist server-side (409 "already paid" = done).
 * Network errors abort the pass without counting an attempt (offline for days never fails a bill);
 * server rejections count, and a bill is set aside as "failed" after MAX_ATTEMPTS.
 * Throws when the pass could not finish (caller backs off).
 */
export async function runSyncPass(): Promise<void> {
  const pending = await listQueue(["pending"]);
  for (const [outletId, group] of groupBy(pending, (p) => p.outletId)) {
    for (let i = 0; i < group.length; i += 200) {
      const batch = group.slice(i, i + 200);
      const { results } = await endpoints.syncOrders(
        batch.map((b) => b.payload),
        outletId,
      );
      for (const r of results) {
        const local = batch.find((b) => b.clientOrderId === r.clientOrderId);
        if (!local) continue;
        if (r.ok && r.orderId) {
          await markCreated(local.clientOrderId, r.orderId, r.invoiceNumber ?? null, r.grandTotal ?? local.grandTotal);
        } else {
          const giveUp = local.attempts + 1 >= MAX_ATTEMPTS;
          await markState(local.clientOrderId, giveUp ? "failed" : "pending", r.error ?? "Sync failed");
        }
      }
    }
  }

  for (const o of await listQueue(["unpaid"])) {
    if (!o.orderId) continue;
    try {
      await endpoints.pay(o.orderId, [{ mode: o.paymentMode, amount: o.grandTotal }], undefined, o.outletId);
      await markState(o.clientOrderId, "done");
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) throw e;
      // 409 "Order is paid" → an earlier attempt already went through.
      if (e instanceof ApiError && e.status === 409) await markState(o.clientOrderId, "done");
      else {
        const giveUp = o.attempts + 1 >= MAX_ATTEMPTS;
        await markState(o.clientOrderId, giveUp ? "failed" : "unpaid", `Payment: ${errorMessage(e)}`);
      }
    }
  }
  await pruneQueue();
}

export type { PendingOrder };
