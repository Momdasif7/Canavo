import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError, endpoints, errorMessage } from "../lib/api";
import {
  countUnsynced,
  enqueueOrder,
  listQueue,
  markCreated,
  markState,
  pruneQueue,
  type PendingOrder,
} from "../lib/db";

const MAX_ATTEMPTS = 3;
const SYNC_INTERVAL_MS = 30_000;

interface OfflineState {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  lastError: string | null;
  failed: PendingOrder[];
  enqueue: (o: Parameters<typeof enqueueOrder>[0]) => Promise<void>;
  syncNow: () => Promise<void>;
}

const OfflineContext = createContext<OfflineState | null>(null);

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of arr) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
}

/**
 * Network status + offline bill queue. Bills raised without a connection are
 * stored in SQLite with a client UUID and flushed through POST /orders/sync
 * (idempotent on clientOrderId). /orders/sync only creates the bill, so the
 * payment taken at the counter is recorded afterwards with POST
 * /orders/:id/payments.
 */
export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [online, setOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [failed, setFailed] = useState<PendingOrder[]>([]);
  const busy = useRef(false);
  const pendingCountRef = useRef(0);
  pendingCountRef.current = pendingCount;

  const refreshCounts = useCallback(async () => {
    setPendingCount(await countUnsynced());
    setFailed(await listQueue(["failed"]));
  }, []);

  const syncNow = useCallback(async () => {
    if (busy.current || !api.hasSession) return;
    busy.current = true;
    setSyncing(true);
    setLastError(null);
    try {
      // 1. Create queued bills on the server, per outlet, in batches of ≤200.
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

      // 2. Record the counter payment for bills that now exist server-side.
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
    } catch (e) {
      setLastError(errorMessage(e, "Sync failed"));
    } finally {
      busy.current = false;
      setSyncing(false);
      await refreshCounts();
    }
  }, [refreshCounts]);

  useEffect(() => {
    void refreshCounts();
    return NetInfo.addEventListener((s) => {
      setOnline(s.isConnected !== false && s.isInternetReachable !== false);
    });
  }, [refreshCounts]);

  // Flush when we come online / sign in, and periodically while bills are waiting.
  useEffect(() => {
    if (status !== "signedIn" || !online) return;
    void syncNow();
    const t = setInterval(() => {
      if (pendingCountRef.current > 0) void syncNow();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [online, status, syncNow]);

  const enqueue = useCallback(
    async (o: Parameters<typeof enqueueOrder>[0]) => {
      await enqueueOrder(o);
      await refreshCounts();
    },
    [refreshCounts],
  );

  const value = useMemo(
    () => ({ online, pendingCount, syncing, lastError, failed, enqueue, syncNow }),
    [online, pendingCount, syncing, lastError, failed, enqueue, syncNow],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineState {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error("useOffline must be used inside <OfflineProvider>");
  return ctx;
}
