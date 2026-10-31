import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { endpoints } from "../lib/api";
import { cachedOutlet, cacheOutlet } from "../lib/db";
import { useSocketEvent } from "../lib/socket";
import type { Outlet } from "../lib/types";

/**
 * Current outlet settings (GST on/off, pricing) for screens outside the POS:
 * the cached copy first, then GET /outlets/current; refreshed on
 * `outlet:updated`. null until known — callers must hide GST rows meanwhile.
 */
export function useCurrentOutlet(): Outlet | null {
  const { outlet: ref } = useAuth();
  const id = ref?.id ?? null;
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setOutlet(null);
      return;
    }
    let cancelled = false;
    cachedOutlet(id)
      .then((c) => {
        if (!cancelled && c) setOutlet((cur) => cur ?? c.value);
      })
      .catch(() => undefined);
    endpoints
      .currentOutlet()
      .then((o) => {
        if (cancelled) return;
        setOutlet(o);
        void cacheOutlet(o).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  useSocketEvent("outlet:updated", () => setTick((n) => n + 1));
  return outlet && outlet.id === id ? outlet : null;
}
