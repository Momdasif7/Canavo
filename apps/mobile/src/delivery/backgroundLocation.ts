/**
 * Gap 3 (P2, approved; docs/qa/known-gaps.md §3): delivery-partner location in the background.
 *
 * - Runs ONLY while the outlet allows it (Outlet.backgroundTracking), the partner is clocked in and on a run
 *   (pickup → back at the outlet). The server enforces the same rules and answers `stop` when they no longer hold.
 * - expo-location `startLocationUpdatesAsync` + expo-task-manager task (defined at module load: this file is imported
 *   from app/_layout.tsx so the task exists when the OS wakes the app headless).
 * - Android: foreground-service notification ("Delivering order …"). iOS: "Always" permission + blue location pill.
 * - Battery-aware: Balanced accuracy every 30 s / 50 m; on low battery or low-power mode, Low accuracy every 2 min / 200 m.
 * - Points are queued in SQLite and uploaded in batches (POST /delivery/me/location/batch), so a dead zone loses nothing
 *   recent; the queue is capped and the server drops points older than 30 min.
 * - Refused / not granted → the foreground-only hooks (useLiveLocation / usePresenceLocation) keep working as before.
 */
import * as Battery from "expo-battery";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { LOCATION_BATCH_MAX } from "@canavo/shared";
import { api, ApiError } from "../lib/api";
import { clearLocations, deleteLocationsUpTo, enqueueLocations, kvGet, kvSet, peekLocations } from "../lib/db";

export const BACKGROUND_LOCATION_TASK = "canavo-delivery-location";
/** Partner's answer to the in-app disclosure (asked once; can be changed from the presence card). */
const CHOICE_KEY = "canavo.bgLocationChoice";

export type BatteryMode = "normal" | "saver";
export interface TrackingOptions {
  accuracy: Location.Accuracy;
  timeInterval: number;
  distanceInterval: number;
}

/** Battery-aware interval: normal 30 s / 50 m (Balanced); below 20 % or in low-power mode 2 min / 200 m (Low). */
export function trackingOptions(mode: BatteryMode): TrackingOptions {
  return mode === "saver"
    ? { accuracy: Location.Accuracy.Low, timeInterval: 120_000, distanceInterval: 200 }
    : { accuracy: Location.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 50 };
}

export async function batteryMode(): Promise<BatteryMode> {
  try {
    const [level, lowPower] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.isLowPowerModeEnabledAsync()]);
    return lowPower || (level >= 0 && level < 0.2) ? "saver" : "normal";
  } catch {
    return "normal";
  }
}

/** Upload queued points. Returns true when the server says to stop (off duty, setting off, run over). */
export async function flushQueue(): Promise<boolean> {
  if (!api.hasSession) await api.restore();
  if (!api.hasSession) return true; // signed out: nothing may be shared
  for (;;) {
    const batch = await peekLocations(LOCATION_BATCH_MAX);
    if (!batch.length) return false;
    try {
      const r = await api.post<{ stop?: boolean }>("/delivery/me/location/batch", {
        background: true,
        points: batch.map((p) => ({ lat: p.lat, lng: p.lng, at: p.at, ...(p.accuracy != null ? { accuracy: p.accuracy } : {}) })),
      });
      await deleteLocationsUpTo(batch[batch.length - 1].id);
      if (r?.stop) return true;
    } catch (e) {
      if (e instanceof ApiError && (e.details as { stop?: boolean } | undefined)?.stop) return true;
      if (e instanceof ApiError && e.status === 400) {
        await deleteLocationsUpTo(batch[batch.length - 1].id); // malformed: never retry forever
        continue;
      }
      return false; // offline / server busy: keep the queue for the next wake-up
    }
  }
}

/** Task body (exported for tests): queue the OS's fixes, upload, stop when the server says so. */
export async function handleLocations(locations: Location.LocationObject[]): Promise<void> {
  if (locations.length) {
    await enqueueLocations(
      locations.map((l) => ({ lat: l.coords.latitude, lng: l.coords.longitude, accuracy: l.coords.accuracy ?? null, at: new Date(l.timestamp).toISOString() })),
    );
  }
  if (await flushQueue()) await stopBackgroundLocation();
}

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    try {
      await handleLocations(data.locations ?? []);
    } catch {
      // Never crash a headless task; the next wake-up retries the queue.
    }
  });
}

export async function isBackgroundLocationRunning(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    return false;
  }
}

/** Start (or update) the background task. Caller has the "Always" permission. */
export async function startBackgroundLocation(label: string): Promise<BatteryMode> {
  const mode = await batteryMode();
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    ...trackingOptions(mode),
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: label,
      notificationBody: "CANAVO shares your location with the outlet until you're back. It stops by itself.",
      notificationColor: "#FF6B35",
      killServiceOnDestroy: true,
    },
  });
  return mode;
}

/** Stop the task and drop anything not yet sent (off duty: nothing may be shared later). */
export async function stopBackgroundLocation(): Promise<void> {
  if (await isBackgroundLocationRunning()) {
    try {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    } catch {
      /* already stopped */
    }
  }
  await clearLocations();
}

export type DisclosureChoice = "accepted" | "declined" | null;
export async function readChoice(): Promise<DisclosureChoice> {
  const v = (await kvGet<string>(CHOICE_KEY))?.value;
  return v === "accepted" || v === "declined" ? v : null;
}
export async function writeChoice(v: DisclosureChoice): Promise<void> {
  await kvSet(CHOICE_KEY, v ?? "");
}

/**
 * Ask for background ("Allow all the time") permission after the in-app disclosure was accepted. Foreground first (the OS
 * requires it), then background. Android 11+ sends the user to Settings for "Allow all the time"; iOS may grant
 * "While using" only. Anything short of background → false (foreground-only fallback).
 */
export async function requestBackgroundPermission(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.status === "granted";
}
