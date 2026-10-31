"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUUpLeft, MapPinLine, Moped, Storefront } from "@phosphor-icons/react";
import { distanceMeters } from "@canavo/shared";
import { api } from "@/lib/api";
import type { PartnerAvailability, PartnerLocationResult } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useDuty } from "./duty";

/** GPS is posted at most this often… */
const MIN_INTERVAL = 20_000;
/** …and only when the partner moved this far, or this much time passed since the last post. */
const MIN_MOVE_METERS = 15;
const MAX_SILENCE = 60_000;

type GeoProblem = "denied" | "unavailable" | null;

interface RunState {
  /** GET /delivery/me/status (null = not loaded / not a partner of this outlet) */
  status: PartnerAvailability | null;
  /** Metres from the outlet at the last GPS post */
  distance: number | null;
  geo: GeoProblem;
  reload: () => Promise<void>;
}

const RunContext = createContext<RunState>({ status: null, distance: null, geo: null, reload: async () => undefined });

export const useRun = () => useContext(RunContext);

interface Fix {
  lat: number;
  lng: number;
  accuracy?: number;
}

/**
 * Delivery partner dispatch state + GPS while on duty. The outlet uses the GPS to
 * see when the partner is back after a run (new orders unlock only then), so it
 * runs whether or not they have an active delivery.
 */
export function RunStatusProvider({ children }: { children: React.ReactNode }) {
  const { can, outletId } = useSession();
  const toast = useToast();
  const duty = useDuty();
  const allowed = can("delivery:own") && !!outletId;
  const [status, setStatus] = useState<PartnerAvailability | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [geo, setGeo] = useState<GeoProblem>(null);

  const reload = useCallback(async () => {
    if (!allowed) return;
    try {
      const s = await api.get<PartnerAvailability | null>("/delivery/me/status");
      setStatus(s);
    } catch {
      /* keep the last known state */
    }
  }, [allowed]);

  // Clocking in / out changes availability (clock-in at the outlet also counts as back).
  const clockedIn = duty.status?.clockedIn;
  useEffect(() => {
    void reload();
  }, [reload, clockedIn]);
  useSocketEvent("delivery:updated", () => void reload());

  const onDuty = status?.onDuty ?? clockedIn ?? false;

  // ----- GPS while on duty -----
  const last = useRef<{ fix: Fix; at: number } | null>(null);
  const latest = useRef<Fix | null>(null);
  const sending = useRef(false);

  const maybeSend = useCallback(async () => {
    const fix = latest.current;
    if (!fix || sending.current) return;
    const now = Date.now();
    const prev = last.current;
    if (prev) {
      const elapsed = now - prev.at;
      if (elapsed < MIN_INTERVAL) return;
      const moved = distanceMeters({ latitude: prev.fix.lat, longitude: prev.fix.lng }, { latitude: fix.lat, longitude: fix.lng });
      if (moved < MIN_MOVE_METERS && elapsed < MAX_SILENCE) return;
    }
    sending.current = true;
    last.current = { fix, at: now };
    try {
      const res = await api.post<PartnerLocationResult>("/delivery/me/location", fix);
      setDistance(res.distanceToOutlet);
      if (res.backNow) {
        toast("You're back at the outlet", "success");
        void reload();
      }
    } catch {
      /* offline: the next fix retries */
    } finally {
      sending.current = false;
    }
  }, [toast, reload]);

  const sendRef = useRef(maybeSend);
  sendRef.current = maybeSend;

  useEffect(() => {
    if (!allowed || !onDuty) {
      setGeo(null);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeo("unavailable");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGeo(null);
        latest.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
        void sendRef.current();
      },
      (err) => setGeo(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
    );
    // A stationary phone may not report new fixes: re-post the last one once a minute.
    const timer = window.setInterval(() => void sendRef.current(), MIN_INTERVAL);
    return () => {
      navigator.geolocation.clearWatch(id);
      window.clearInterval(timer);
    };
  }, [allowed, onDuty]);

  const value = useMemo<RunState>(() => ({ status, distance, geo, reload }), [status, distance, geo, reload]);
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

const formatDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

/** "At the outlet — can take 1 more order" / "On a run" / "Returning…" — top of the partner pages. */
export function RunStatusBanner() {
  const { status, distance, geo } = useRun();
  if (!status?.onDuty) return null;

  let tone: "good" | "busy" | "away";
  let icon: React.ReactNode;
  let text: string;
  if (status.outForDelivery > 0) {
    tone = "busy";
    icon = <Moped size={24} weight="duotone" />;
    text = "On a run — deliver your orders";
  } else if (!status.atOutlet) {
    tone = "away";
    icon = <ArrowUUpLeft size={24} weight="bold" />;
    text = `Returning — new orders unlock when you're back at the outlet${distance != null ? ` (${formatDistance(distance)} away)` : ""}`;
  } else {
    const left = Math.max(0, status.max - status.active);
    tone = left > 0 ? "good" : "busy";
    icon = <Storefront size={24} weight="duotone" />;
    text = left > 0 ? `At the outlet — can take ${left} more order${left === 1 ? "" : "s"}` : `At the outlet — you have ${status.active} of ${status.max} orders, pick them up to go`;
  }

  return (
    <div
      className={clsx(
        "rounded-2xl border px-4 py-3",
        tone === "good" && "border-secondary/40 bg-secondary-50 text-secondary-700 dark:bg-secondary/20 dark:text-green-200",
        tone === "busy" && "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
        tone === "away" && "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
      )}
      role="status"
      data-testid="run-status"
    >
      <p className="flex items-center gap-3 text-sm font-bold">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">{text}</span>
      </p>
      {geo && (
        <p className="mt-2 flex items-start gap-2 text-sm font-semibold text-red-700 dark:text-red-300" data-testid="location-off">
          <MapPinLine size={18} className="mt-0.5 shrink-0" />
          <span>
            Turn on location so the outlet knows when you&apos;re back
            {geo === "denied" ? " — allow location for this site in your browser settings." : "."}
          </span>
        </p>
      )}
    </div>
  );
}
