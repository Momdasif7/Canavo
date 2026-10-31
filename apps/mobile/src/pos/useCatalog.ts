import { useCallback, useEffect, useState } from "react";
import { endpoints, errorMessage } from "../lib/api";
import { cachedMenu, cachedOutlet, cacheMenu, cacheOutlet } from "../lib/db";
import { useSocketEvent } from "../lib/socket";
import type { Menu, Outlet } from "../lib/types";

interface Catalog {
  menu: Menu | null;
  outlet: Outlet | null;
  loading: boolean;
  error: string | null;
  /** ms timestamp of the cached copy in use, when offline */
  cachedAt: number | null;
  reload: () => Promise<void>;
}

/**
 * Menu + outlet tax settings for the POS. Always tries the network first and
 * refreshes the SQLite cache; falls back to the cache so billing keeps working
 * without a connection.
 */
export function useCatalog(outletId: string | null): Catalog {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!outletId) return;
    setLoading(true);
    setError(null);
    try {
      const [m, o] = await Promise.all([endpoints.menu(), endpoints.currentOutlet()]);
      setMenu(m);
      setOutlet(o);
      setCachedAt(null);
      await Promise.all([cacheMenu(outletId, m), cacheOutlet(o)]);
    } catch (e) {
      const [m, o] = await Promise.all([cachedMenu(outletId), cachedOutlet(outletId)]);
      if (m && o) {
        setMenu(m.value);
        setOutlet(o.value);
        setCachedAt(Math.min(m.updatedAt, o.updatedAt));
      } else {
        setError(errorMessage(e, "Could not load the menu"));
      }
    } finally {
      setLoading(false);
    }
  }, [outletId]);

  useEffect(() => {
    setMenu(null);
    setOutlet(null);
    void reload();
  }, [reload]);

  useSocketEvent("menu:changed", () => {
    void reload();
  });
  // A manager switching GST off (or changing pricing settings) re-prices open carts.
  useSocketEvent("outlet:updated", () => {
    void reload();
  });

  return { menu, outlet, loading, error, cachedAt, reload };
}
