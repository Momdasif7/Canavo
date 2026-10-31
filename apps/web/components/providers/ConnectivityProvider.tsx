"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getSession, isNetworkError, pingApi, subscribeReachability } from "@/lib/api";
import { flushQueue, listQueue, subscribeQueue } from "@/lib/offline";
import { useToast } from "./ToastProvider";

interface ConnectivityValue {
  online: boolean;
  pending: number;
  failed: number;
  syncing: boolean;
  sync: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityValue>({ online: true, pending: 0, failed: 0, syncing: false, sync: async () => {} });

/**
 * Tracks whether the API is reachable (browser online flag + failed requests),
 * the offline bill queue, and flushes the queue as soon as we're back online.
 */
export function ConnectivityProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [browserOnline, setBrowserOnline] = useState(true);
  const [reachable, setReachable] = useState(true);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const online = browserOnline && reachable;
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const refreshCounts = useCallback(async () => {
    const q = await listQueue();
    setPending(q.length);
    setFailed(q.filter((x) => x.lastError).length);
  }, []);

  const sync = useCallback(async () => {
    if (!getSession() || !onlineRef.current) return;
    if (!(await listQueue()).length) return;
    setSyncing(true);
    try {
      const { synced, failed: f } = await flushQueue();
      if (synced) toast(`Synced ${synced} offline bill${synced > 1 ? "s" : ""}`, "success");
      if (f) toast(`${f} offline bill${f > 1 ? "s" : ""} could not sync — see Bills`, "error");
    } catch (e) {
      if (!isNetworkError(e)) toast("Offline sync failed; will retry", "error");
    } finally {
      setSyncing(false);
      void refreshCounts();
    }
  }, [refreshCounts, toast]);

  useEffect(() => {
    setBrowserOnline(navigator.onLine);
    const up = () => {
      setBrowserOnline(true);
      void pingApi();
    };
    const down = () => setBrowserOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const unsubReach = subscribeReachability(setReachable);
    const unsubQueue = subscribeQueue(() => void refreshCounts());
    void refreshCounts();
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      unsubReach();
      unsubQueue();
    };
  }, [refreshCounts]);

  // While unreachable, probe the API every 10s.
  useEffect(() => {
    if (reachable || !browserOnline) return;
    const id = window.setInterval(() => void pingApi(), 10_000);
    return () => window.clearInterval(id);
  }, [reachable, browserOnline]);

  // Back online (or app start) → flush the queue; retry periodically if anything is left.
  useEffect(() => {
    if (!online) return;
    void sync();
    const id = window.setInterval(() => void sync(), 60_000);
    return () => window.clearInterval(id);
  }, [online, sync]);

  return <ConnectivityContext.Provider value={{ online, pending, failed, syncing, sync }}>{children}</ConnectivityContext.Provider>;
}

export const useConnectivity = () => useContext(ConnectivityContext);
