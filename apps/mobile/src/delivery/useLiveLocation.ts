import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Location from "expo-location";
import { distanceMeters } from "@canavo/shared";
import { endpoints, errorMessage } from "../lib/api";
import type { PartnerLocationResult } from "../lib/types";

export const LOCATION_POST_MS = 30_000;

interface LiveLocation {
  sharing: boolean;
  lastSentAt: number | null;
  error: string | null;
  remainingKm: Record<string, number | null>;
}

/**
 * While the agent has deliveries OUT_FOR_DELIVERY, watch the foreground
 * location and POST /delivery/:id/location every ~30 s (and once at start).
 *
 * Foreground only: updates pause when the app is backgrounded or the screen
 * is locked. Where the outlet allows it and the partner granted "Allow all the
 * time", the background task in backgroundLocation.ts covers that gap (gap 3);
 * otherwise this hook is the fallback.
 */
export function useLiveLocation(deliveryIds: string[]): LiveLocation {
  const [state, setState] = useState<LiveLocation>({ sharing: false, lastSentAt: null, error: null, remainingKm: {} });
  const latest = useRef<{ lat: number; lng: number } | null>(null);
  const idsKey = [...deliveryIds].sort().join(",");

  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (!ids.length) {
      setState((s) => ({ ...s, sharing: false }));
      return;
    }
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const post = async () => {
      const pos = latest.current;
      if (!pos || cancelled) return;
      const results = await Promise.allSettled(ids.map((id) => endpoints.deliveryLocation(id, pos.lat, pos.lng)));
      if (cancelled) return;
      const remaining: Record<string, number | null> = {};
      let failure: string | null = null;
      results.forEach((r, i) => {
        if (r.status === "fulfilled") remaining[ids[i]] = r.value.remainingKm;
        else failure = errorMessage(r.reason, "Could not share location");
      });
      setState((s) => ({ ...s, sharing: true, lastSentAt: Date.now(), error: failure, remainingKm: { ...s.remainingKm, ...remaining } }));
    };

    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") throw new Error("Allow location so the outlet can track the delivery.");
        let first = true;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: 20 },
          (loc) => {
            latest.current = { lat: loc.coords.latitude, lng: loc.coords.longitude };
            if (first) {
              first = false;
              void post();
            }
          },
        );
        if (cancelled) {
          sub.remove();
          return;
        }
        setState((s) => ({ ...s, sharing: true, error: null }));
        timer = setInterval(() => void post(), LOCATION_POST_MS);
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, sharing: false, error: errorMessage(e, "Location unavailable") }));
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      if (timer) clearInterval(timer);
    };
  }, [idsKey]);

  return state;
}

// ---------- Back-at-outlet presence (dispatch limit) ----------
/** Report at least this often while clocked in… */
export const PRESENCE_POST_MS = 20_000;
/** …or sooner after moving this far (metres). */
export const PRESENCE_MOVE_M = 15;

export interface PresenceLocation {
  /** "denied" → ask the partner to turn location on */
  permission: "unknown" | "granted" | "denied";
  /** Latest POST /delivery/me/location answer */
  last: PartnerLocationResult | null;
  lastSentAt: number | null;
  error: string | null;
}

/**
 * While the partner is clocked in (`enabled`), watch the foreground location
 * and POST /delivery/me/location every ~20 s or after > 15 m of movement —
 * with or without active deliveries — so the outlet knows when they're back
 * and can give them new orders. `onBack` fires when a report brings them back
 * from a run (`backNow`).
 *
 * Foreground permission only (no background task): reports pause while the
 * app is backgrounded; the partner can also clock in at the outlet or a
 * manager can tap "Mark back at outlet".
 */
export function usePresenceLocation(enabled: boolean, onBack?: (r: PartnerLocationResult) => void): PresenceLocation & { retry: () => void } {
  const [state, setState] = useState<PresenceLocation>({ permission: "unknown", last: null, lastSentAt: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, last: null, lastSentAt: null, error: null }));
      return;
    }
    let cancelled = false;
    let sub: Location.LocationSubscription | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let latest: { latitude: number; longitude: number; accuracy?: number } | null = null;
    let sent: { latitude: number; longitude: number; at: number } | null = null;
    let inFlight = false;

    const post = async () => {
      const pos = latest;
      if (!pos || cancelled || inFlight) return;
      const due = !sent || Date.now() - sent.at >= PRESENCE_POST_MS || distanceMeters(sent, pos) > PRESENCE_MOVE_M;
      if (!due) return;
      inFlight = true;
      sent = { latitude: pos.latitude, longitude: pos.longitude, at: Date.now() };
      try {
        const r = await endpoints.reportMyLocation(pos.latitude, pos.longitude, pos.accuracy);
        if (cancelled) return;
        setState((s) => ({ ...s, last: r, lastSentAt: Date.now(), error: null }));
        if (r.backNow) onBackRef.current?.(r);
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e, "Could not share location") }));
      } finally {
        inFlight = false;
      }
    };

    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (perm.status !== "granted") {
          setState((s) => ({ ...s, permission: "denied", error: null }));
          return;
        }
        setState((s) => ({ ...s, permission: "granted", error: null }));
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 10_000, distanceInterval: PRESENCE_MOVE_M },
          (loc) => {
            latest = { latitude: loc.coords.latitude, longitude: loc.coords.longitude, accuracy: loc.coords.accuracy ?? undefined };
            void post();
          },
        );
        if (cancelled) {
          sub.remove();
          return;
        }
        // Standing still produces no watch events: re-send the last fix once it's due (~every 20 s).
        timer = setInterval(() => void post(), 5_000);
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e, "Location unavailable") }));
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
      if (timer) clearInterval(timer);
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return useMemo(() => ({ ...state, retry }), [state, retry]);
}
