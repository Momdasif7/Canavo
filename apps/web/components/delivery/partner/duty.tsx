"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Clock, MapPinLine, SignIn, SignOut, X } from "@phosphor-icons/react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { AttendanceStatus } from "@/lib/types-delivery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

type ClockKind = "in" | "out";
interface Coords {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

interface DutyState {
  /** Attendance is available for this user (module on + permission) */
  available: boolean;
  status: AttendanceStatus | null;
  loading: boolean;
  busy: ClockKind | null;
  clockIn: () => void;
  clockOut: () => void;
  reload: () => Promise<void>;
}

const DutyContext = createContext<DutyState>({
  available: false,
  status: null,
  loading: false,
  busy: null,
  clockIn: () => undefined,
  clockOut: () => undefined,
  reload: async () => undefined,
});

export const useDuty = () => useContext(DutyContext);

/** Current position, high accuracy; friendly errors for the partner. */
function getCoords(): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This browser can't share your location. Use the CANAVO app or another browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location access is blocked. Allow location for this site in your browser settings, then try again."
              : "Couldn't get your location. Turn on GPS / move near a window and try again.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  });
}

const codeOf = (e: unknown) => (e instanceof ApiError ? (e.details as { code?: string } | undefined)?.code : undefined);

/** Clock in / out for the delivery partner portal: one state shared by the duty bar and the pages. */
export function DutyProvider({ children }: { children: React.ReactNode }) {
  const { can, outletId } = useSession();
  const toast = useToast();
  const allowed = can("attendance:self");
  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [available, setAvailable] = useState(allowed);
  const [loading, setLoading] = useState(allowed);
  const [busy, setBusy] = useState<ClockKind | null>(null);
  const [pinAsk, setPinAsk] = useState<{ kind: ClockKind; coords: Coords; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!allowed || !outletId) return;
    try {
      setStatus(await api.get<AttendanceStatus>("/attendance/me/status"));
      setAvailable(true);
    } catch (e) {
      // Attendance module off for this business: hide the duty bar quietly.
      if (e instanceof ApiError && e.status === 403) setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [allowed, outletId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Returns true when done (or handled), false to keep a PIN dialog open with an error. */
  const run = useCallback(
    async (kind: ClockKind, given?: { coords: Coords; pin?: string }): Promise<boolean> => {
      setBusy(kind);
      setError(null);
      let coords = given?.coords;
      try {
        coords ??= await getCoords();
      } catch (e) {
        setError(errorMessage(e));
        setBusy(null);
        return true;
      }
      try {
        await api.post(`/attendance/clock-${kind}`, { ...coords, ...(given?.pin && { pin: given.pin }), ...(outletId && { outletId }) });
        setPinAsk(null);
        toast(kind === "in" ? "Clocked in — have a good shift!" : "Clocked out. See you next shift!", "success");
        await reload();
        return true;
      } catch (e) {
        const code = codeOf(e);
        if (code === "PIN_REQUIRED") {
          setPinAsk({ kind, coords });
          return false;
        }
        if (code === "WRONG_PIN") {
          setPinAsk({ kind, coords, error: "Incorrect PIN — try again" });
          return false;
        }
        setPinAsk(null);
        if (code === "OUTSIDE_GEOFENCE") {
          const d = (e as ApiError).details as { distance?: number; allowed?: number };
          setError(`You are ${d.distance ?? "?"}m from the outlet. Clock in at the outlet${d.allowed ? ` (within ${d.allowed}m)` : ""}.`);
        } else if (code === "ALREADY_CLOCKED_IN" || code === "NOT_CLOCKED_IN") {
          toast(code === "ALREADY_CLOCKED_IN" ? "You're already clocked in" : "You're already clocked out", "info");
          await reload();
        } else {
          setError(errorMessage(e));
        }
        return true;
      } finally {
        setBusy(null);
      }
    },
    [outletId, reload, toast],
  );

  const value = useMemo<DutyState>(
    () => ({
      available: allowed && available,
      status,
      loading,
      busy,
      clockIn: () => void run("in"),
      clockOut: () => void run("out"),
      reload,
    }),
    [allowed, available, status, loading, busy, run, reload],
  );

  return (
    <DutyContext.Provider value={value}>
      <DutyErrorContext.Provider value={{ error, dismiss: () => setError(null) }}>{children}</DutyErrorContext.Provider>
      <PinDialog
        ask={pinAsk}
        busy={busy !== null}
        onClose={() => setPinAsk(null)}
        onSubmit={(pin) => {
          if (pinAsk) void run(pinAsk.kind, { coords: pinAsk.coords, pin });
        }}
      />
    </DutyContext.Provider>
  );
}

const DutyErrorContext = createContext<{ error: string | null; dismiss: () => void }>({ error: null, dismiss: () => undefined });

function PinDialog({
  ask,
  busy,
  onClose,
  onSubmit,
}: {
  ask: { kind: ClockKind; error?: string } | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState("");
  useEffect(() => {
    setPin("");
  }, [ask]);
  const valid = /^\d{4,6}$/.test(pin);
  return (
    <Dialog
      open={!!ask}
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      title={ask?.kind === "out" ? "Enter your PIN to clock out" : "Enter your PIN to clock in"}
      description="Your 4–6 digit attendance PIN"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="duty-pin-form" loading={busy} disabled={!valid}>
            {ask?.kind === "out" ? "Clock out" : "Clock in"}
          </Button>
        </>
      }
    >
      <form
        id="duty-pin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSubmit(pin);
        }}
      >
        <Input
          aria-label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          error={ask?.error}
          className="tabular !min-h-[56px] text-center text-2xl tracking-[0.5em]"
          data-autofocus
        />
      </form>
    </Dialog>
  );
}

/** "On duty since 9:05 AM · Clock out" / "Off duty · Clock in" — top of every partner page. */
export function DutyBar() {
  const duty = useDuty();
  const { error, dismiss } = useContext(DutyErrorContext);
  if (!duty.available) return null;
  const on = duty.status?.clockedIn ?? false;
  const since = duty.status?.current?.clockInAt;
  return (
    <div className="space-y-2" data-testid="duty-bar">
      <div
        className={clsx(
          "flex min-h-[56px] items-center gap-3 rounded-2xl border px-3 py-2 sm:px-4",
          on ? "border-secondary/40 bg-secondary-50 dark:bg-secondary/20" : "border-line bg-surface",
        )}
      >
        <span className={clsx("h-3 w-3 shrink-0 rounded-full", on ? "bg-green-500 ring-4 ring-green-500/20" : "bg-line")} aria-hidden />
        <p className="min-w-0 flex-1 text-[15px] font-bold leading-tight" data-testid="duty-status">
          {duty.loading && !duty.status ? (
            <span className="text-muted">Checking duty…</span>
          ) : on ? (
            <>
              On duty
              {since && <span className="font-semibold text-muted"> since {formatTime(since)}</span>}
            </>
          ) : (
            <span className="text-muted">Off duty</span>
          )}
        </p>
        {on ? (
          <Button variant="outline" className="shrink-0" loading={duty.busy === "out"} disabled={duty.busy !== null} onClick={duty.clockOut} icon={<SignOut size={20} />}>
            Clock out
          </Button>
        ) : (
          <Button variant="secondary" className="shrink-0" loading={duty.busy === "in"} disabled={duty.busy !== null || duty.loading} onClick={duty.clockIn} icon={<SignIn size={20} />}>
            Clock in
          </Button>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Alert>
              <span className="flex items-start gap-2">
                <MapPinLine size={20} className="mt-0.5 shrink-0" />
                {error}
              </span>
            </Alert>
          </div>
          <IconButton label="Dismiss" onClick={dismiss}>
            <X size={20} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** Gentle nudge on My deliveries while off duty — never blocks the work. */
export function OffDutyBanner() {
  const duty = useDuty();
  if (!duty.available || duty.loading || duty.status?.clockedIn !== false) return null;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100" data-testid="off-duty-banner">
      <Clock size={24} className="shrink-0" weight="duotone" />
      <p className="min-w-0 flex-1 text-sm font-semibold">Clock in to start your shift — the outlet assigns orders to partners on duty.</p>
      <Button size="sm" variant="secondary" className="shrink-0" loading={duty.busy === "in"} onClick={duty.clockIn}>
        Clock in
      </Button>
    </div>
  );
}
