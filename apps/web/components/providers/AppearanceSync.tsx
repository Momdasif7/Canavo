"use client";

import { useEffect } from "react";
import type { Brand, UserPreferences } from "@canavo/shared";
import { api } from "@/lib/api";
import { useSession } from "./SessionProvider";
import { useTheme } from "./ThemeProvider";

const SAVE_DELAY_MS = 600;

/**
 * Bridges the signed-in session and the theme: applies the business brand and the user's own
 * preferences from /auth/me, and saves the user's changes to their account (batched, so dragging
 * the colour picker doesn't send a request per pixel). Signed out, changes stay on this device.
 */
export function AppearanceSync() {
  const { me } = useSession();
  const { hydrate, setPersister } = useTheme();
  const userId = me?.id ?? null;

  // A cached /auth/me from an older build has no brand / preferences: keep the device's look then.
  // Keyed by value, so re-fetching an unchanged /auth/me doesn't re-apply (or undo a brand preview).
  const serverLook = me?.preferences && me.brand ? JSON.stringify({ prefs: me.preferences, brand: me.brand }) : null;
  useEffect(() => {
    if (!serverLook) return;
    const { prefs, brand } = JSON.parse(serverLook) as { prefs: UserPreferences; brand: Brand };
    hydrate(prefs, brand);
  }, [serverLook, hydrate]);

  useEffect(() => {
    if (!userId) return;
    let pending: Partial<UserPreferences> = {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const patch = pending;
      pending = {};
      // Best effort: offline, the change still applies on this device (and is re-sent with the next change).
      api.put("/auth/me/preferences", patch, { outletId: null }).catch(() => {
        pending = { ...patch, ...pending };
      });
    };
    setPersister((patch) => {
      pending = { ...pending, ...patch };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    });
    return () => {
      setPersister(null);
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
  }, [userId, setPersister]);

  return null;
}
