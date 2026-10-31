import { useCallback, useEffect, useRef, useState } from "react";
import { endpoints, errorMessage } from "../lib/api";
import { kvGet, kvSet } from "../lib/db";
import { useSocketEvent } from "../lib/socket";
import type { Delivery } from "../lib/types";

const POLL_MS = 30_000;

/**
 * The partner's active deliveries (GET /delivery/mine), refreshed on
 * `delivery:updated` / `notification` / `order:paid` and every 30 s. The last
 * good list is cached on the phone so the screen still works with no signal.
 */
export function useMyDeliveries(userId: string, outletId: string | null) {
  const key = `delivery:mine:${userId}:${outletId ?? "-"}`;
  const [list, setList] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async () => {
    try {
      const fresh = await endpoints.myDeliveries();
      setList(fresh);
      setError(null);
      setCachedAt(null);
      void kvSet(keyRef.current, fresh).catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setList(null);
    setCachedAt(null);
    void kvGet<Delivery[]>(key)
      .then((c) => {
        if (c && !cancelled) {
          setList((cur) => cur ?? c.value);
          setCachedAt((cur) => cur ?? c.updatedAt);
        }
      })
      .catch(() => undefined);
    void load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [key, load]);

  useSocketEvent("delivery:updated", () => void load());
  useSocketEvent("notification", () => void load());
  useSocketEvent("order:paid", () => void load());

  /** Optimistic local update after an action (the next load replaces it). */
  const patch = useCallback((id: string, next: Partial<Delivery> | null) => {
    setList((cur) => {
      if (!cur) return cur;
      if (next === null) return cur.filter((d) => d.id !== id);
      return cur.map((d) => (d.id === id ? { ...d, ...next } : d));
    });
  }, []);

  return { list, error, cachedAt, load, patch };
}
