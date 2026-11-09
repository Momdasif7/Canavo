import React, { useCallback, useEffect, useState } from "react";
import { AppState, View } from "react-native";
import * as Location from "expo-location";
import { Sheet } from "../components/Sheet";
import { AppText, Button } from "../components/ui";
import { space } from "../theme";
import {
  readChoice,
  requestBackgroundPermission,
  startBackgroundLocation,
  stopBackgroundLocation,
  isBackgroundLocationRunning,
  writeChoice,
  type BatteryMode,
} from "./backgroundLocation";

export type BackgroundMode = "off" | "asking" | "background" | "foreground-only";

export interface BackgroundInput {
  /** Outlet.backgroundTracking (from /delivery/me/status) */
  allowed: boolean;
  onDuty: boolean;
  /** Picked up and not yet back at the outlet */
  onRun: boolean;
  /** Foreground-service notification title, e.g. "Delivering order INV-12" */
  label: string;
}

export interface BackgroundLocation {
  mode: BackgroundMode;
  battery: BatteryMode | null;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  /** Foreground-only partner changes their mind: show the disclosure again. */
  enable: () => Promise<void>;
}

/**
 * Gap 3: decide whether the background task should run, show the prominent disclosure before the OS prompt, fall back
 * to foreground-only when refused. Stops the task the moment the run ends, the partner clocks out or the outlet turns
 * the setting off. Re-checks when the app comes back to the foreground (battery mode, permission changed in Settings).
 */
export function useBackgroundLocation({ allowed, onDuty, onRun, label }: BackgroundInput): BackgroundLocation {
  const [mode, setMode] = useState<BackgroundMode>("off");
  const [battery, setBattery] = useState<BatteryMode | null>(null);
  const [wake, setWake] = useState(0);
  const active = allowed && onDuty && onRun;

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => s === "active" && setWake((n) => n + 1));
    return () => sub.remove();
  }, []);

  const start = useCallback(async () => {
    try {
      setBattery(await startBackgroundLocation(label));
      setMode("background");
    } catch {
      setMode("foreground-only");
    }
  }, [label]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!active) {
        setMode("off");
        setBattery(null);
        if (await isBackgroundLocationRunning()) await stopBackgroundLocation();
        return;
      }
      const choice = await readChoice();
      if (cancelled) return;
      if (choice === "declined") return setMode("foreground-only");
      if (choice === null) return setMode("asking");
      const perm = await Location.getBackgroundPermissionsAsync();
      if (cancelled) return;
      if (perm.status === "granted") await start();
      else setMode("foreground-only");
    })().catch(() => !cancelled && setMode("foreground-only"));
    return () => {
      cancelled = true;
    };
  }, [active, start, wake]);

  const accept = useCallback(async () => {
    await writeChoice("accepted");
    if (await requestBackgroundPermission()) await start();
    else setMode("foreground-only");
  }, [start]);

  const decline = useCallback(async () => {
    await writeChoice("declined");
    setMode("foreground-only");
  }, []);

  const enable = useCallback(async () => {
    await writeChoice(null);
    setMode("asking");
  }, []);

  return { mode, battery, accept, decline, enable };
}

/** Prominent in-app disclosure (Play "background location" policy) shown before the OS permission prompt. */
export function BackgroundDisclosure({ bg }: { bg: BackgroundLocation }) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={bg.mode === "asking"} onClose={() => void bg.decline()} title="Share location while delivering?">
      <View style={{ gap: space.md }}>
        <AppText>
          CANAVO collects your location even when the app is closed or not in use, but only while you are on a delivery run: from
          pickup until you are back at the outlet. Your outlet uses it to follow the delivery and to know when you are back.
        </AppText>
        <AppText variant="muted">
          It stops by itself when you are back or clock out. A notification shows while it is on. Nothing is shared when you are
          off duty, and the outlet keeps only your latest position. On the next screen choose &quot;Allow all the time&quot;.
        </AppText>
        <Button title="Continue" icon="navigate" loading={busy} onPress={run(bg.accept)} />
        <Button title="Not now (only while the app is open)" variant="secondary" disabled={busy} onPress={run(bg.decline)} />
      </View>
    </Sheet>
  );
}
