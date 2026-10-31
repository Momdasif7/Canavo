import { useCallback, useEffect, useRef, useState } from "react";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import * as Location from "expo-location";
import { ApiError, endpoints, errorMessage } from "../lib/api";
import type { AttendanceStatus } from "../lib/types";

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  at: number;
}

export type ClockErrorKind = "permission" | "gps" | "geofence" | "biometric" | "conflict" | "other";
export interface ClockError {
  kind: ClockErrorKind;
  title: string;
  message: string;
}

type Phase = "idle" | "locating" | "verifying" | "submitting";

const FIX_REUSE_MS = 2 * 60_000;
const GPS_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}

/**
 * Clock in/out: high-accuracy GPS fix → optional biometric confirmation →
 * POST. If the server says a PIN is required, the caller shows the PIN pad and
 * calls submitPin(), which reuses the same GPS fix.
 */
export function useClock(outletId: string | null, enabled = true) {
  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<ClockError | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const fixRef = useRef<Fix | null>(null);

  const reload = useCallback(async () => {
    setStatusError(null);
    // Attendance module off / no permission: nothing to load.
    if (!enabled) {
      setStatus(null);
      setLoadingStatus(false);
      return;
    }
    try {
      setStatus(await endpoints.attendanceStatus());
    } catch (e) {
      setStatusError(errorMessage(e, "Could not load attendance"));
    } finally {
      setLoadingStatus(false);
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const locate = useCallback(async (): Promise<Fix | null> => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") {
      setError({
        kind: "permission",
        title: "Location permission needed",
        message: "CANAVO checks you are at the outlet before clocking in. Allow location access in Settings.",
      });
      return null;
    }
    if (!(await Location.hasServicesEnabledAsync())) {
      setError({ kind: "gps", title: "Location is off", message: "Turn on GPS / Location and try again." });
      return null;
    }
    try {
      const pos = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
        GPS_TIMEOUT_MS,
        "Couldn't get a GPS fix. Step near a window or outside and try again.",
      );
      const f: Fix = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
        at: Date.now(),
      };
      fixRef.current = f;
      setFix(f);
      return f;
    } catch (e) {
      setError({ kind: "gps", title: "No GPS fix", message: errorMessage(e) });
      return null;
    }
  }, []);

  const confirmBiometric = useCallback(async (clockingIn: boolean): Promise<boolean> => {
    try {
      const [hw, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hw || !enrolled) return true; // not available → skip
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: clockingIn ? "Confirm to clock in" : "Confirm to clock out",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (!res.success) {
        setError({ kind: "biometric", title: "Not confirmed", message: "Fingerprint / face check was cancelled." });
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }, []);

  const submit = useCallback(
    async (f: Fix, pin?: string) => {
      const clockingIn = !status?.clockedIn;
      setPhase("submitting");
      try {
        const body = {
          latitude: f.latitude,
          longitude: f.longitude,
          accuracy: f.accuracy ?? undefined,
          pin,
          outletId: outletId ?? undefined,
        };
        if (clockingIn) await endpoints.clockIn(body);
        else await endpoints.clockOut(body);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPinRequired(false);
        setPinError(null);
        setLastAction(clockingIn ? "Clocked in" : "Clocked out");
        await reload();
      } catch (e) {
        const msg = errorMessage(e);
        if (e instanceof ApiError && e.status === 400 && /PIN is required/i.test(msg)) {
          setPinRequired(true);
          setPinError(null);
        } else if (e instanceof ApiError && e.status === 403 && /PIN/i.test(msg)) {
          setPinRequired(true);
          setPinError(msg);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        } else {
          setPinRequired(false);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          if (e instanceof ApiError && e.status === 403 && /\d+m from/.test(msg)) {
            setError({ kind: "geofence", title: "You're outside the outlet", message: msg });
          } else if (e instanceof ApiError && e.status === 409) {
            setError({ kind: "conflict", title: "Already done", message: msg });
            await reload();
          } else {
            setError({ kind: "other", title: clockingIn ? "Clock-in failed" : "Clock-out failed", message: msg });
          }
        }
      } finally {
        setPhase("idle");
      }
    },
    [status?.clockedIn, outletId, reload],
  );

  /** Main button handler. */
  const clock = useCallback(async () => {
    if (phase !== "idle") return;
    setError(null);
    setLastAction(null);
    setPhase("locating");
    const f = await locate();
    if (!f) return setPhase("idle");
    setPhase("verifying");
    if (!(await confirmBiometric(!status?.clockedIn))) return setPhase("idle");
    await submit(f);
  }, [phase, locate, confirmBiometric, submit, status?.clockedIn]);

  const submitPin = useCallback(
    async (pin: string) => {
      let f = fixRef.current;
      if (!f || Date.now() - f.at > FIX_REUSE_MS) {
        setPhase("locating");
        f = await locate();
        if (!f) {
          setPinRequired(false);
          return setPhase("idle");
        }
      }
      await submit(f, pin);
    },
    [locate, submit],
  );

  return {
    status,
    loadingStatus,
    statusError,
    phase,
    fix,
    error,
    pinRequired,
    pinError,
    lastAction,
    clock,
    submitPin,
    cancelPin: () => setPinRequired(false),
    reload,
  };
}
