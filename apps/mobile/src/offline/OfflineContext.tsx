import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "../auth/AuthContext";
import { api, errorMessage } from "../lib/api";
import { countUnsynced, enqueueOrder, listQueue, requeueFailed, type PendingOrder } from "../lib/db";
import { nextSyncDelay, runSyncPass } from "./sync";

interface OfflineState {
  online: boolean;
  pendingCount: number;
  syncing: boolean;
  lastError: string | null;
  failed: PendingOrder[];
  enqueue: (o: Parameters<typeof enqueueOrder>[0]) => Promise<void>;
  syncNow: () => Promise<void>;
  /** Put bills set aside as "failed" back in the queue and sync them again */
  retryFailed: () => Promise<void>;
}

const OfflineContext = createContext<OfflineState | null>(null);

/**
 * Network status + offline bill queue. Bills raised without a connection are
 * stored in SQLite with a client UUID and flushed through POST /orders/sync
 * (idempotent on clientOrderId). /orders/sync only creates the bill, so the
 * payment taken at the counter is recorded afterwards with POST
 * /orders/:id/payments. See ./sync for one pass; automatic retries back off
 * (30 s doubling to 5 min) while the server keeps failing.
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

  /** Consecutive failed passes → automatic retry delay (manual "Sync now" always runs). */
  const failures = useRef(0);
  const [nextDelay, setNextDelay] = useState(nextSyncDelay(0));

  const syncNow = useCallback(async () => {
    if (busy.current || !api.hasSession) return;
    busy.current = true;
    setSyncing(true);
    setLastError(null);
    try {
      await runSyncPass();
      failures.current = 0;
    } catch (e) {
      failures.current += 1;
      setLastError(errorMessage(e, "Sync failed"));
    } finally {
      busy.current = false;
      setSyncing(false);
      setNextDelay(nextSyncDelay(failures.current));
      await refreshCounts();
    }
  }, [refreshCounts]);

  const retryFailed = useCallback(async () => {
    await requeueFailed();
    await refreshCounts();
    await syncNow();
  }, [refreshCounts, syncNow]);

  useEffect(() => {
    void refreshCounts();
    return NetInfo.addEventListener((s) => {
      setOnline(s.isConnected !== false && s.isInternetReachable !== false);
    });
  }, [refreshCounts]);

  // Flush when we come online / sign in…
  useEffect(() => {
    if (status !== "signedIn" || !online) return;
    failures.current = 0;
    void syncNow();
  }, [online, status, syncNow]);

  // …and periodically while bills are waiting, backing off while the server keeps failing.
  useEffect(() => {
    if (status !== "signedIn" || !online) return;
    const t = setInterval(() => {
      if (pendingCountRef.current > 0) void syncNow();
    }, nextDelay);
    return () => clearInterval(t);
  }, [online, status, syncNow, nextDelay]);

  const enqueue = useCallback(
    async (o: Parameters<typeof enqueueOrder>[0]) => {
      await enqueueOrder(o);
      await refreshCounts();
    },
    [refreshCounts],
  );

  const value = useMemo(
    () => ({ online, pendingCount, syncing, lastError, failed, enqueue, syncNow, retryFailed }),
    [online, pendingCount, syncing, lastError, failed, enqueue, syncNow, retryFailed],
  );
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineState {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error("useOffline must be used inside <OfflineProvider>");
  return ctx;
}
