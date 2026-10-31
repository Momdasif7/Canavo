import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../auth/AuthContext";
import { AppText, Button, Notice, Row } from "../components/ui";
import { endpoints } from "../lib/api";
import { useSocketEvent } from "../lib/socket";
import type { PartnerAvailability } from "../lib/types";
import { radius, space, useTheme } from "../theme";
import { metresText, partnerState } from "./portal";
import { usePresenceLocation, type PresenceLocation } from "./useLiveLocation";

const STATUS_POLL_MS = 60_000;
/** Don't say "You're back" twice for one return (GPS + socket). */
const BACK_DEDUPE_MS = 60_000;

interface PartnerPresence {
  /** GET /delivery/me/status; null until loaded / not a partner here */
  status: PartnerAvailability | null;
  location: PresenceLocation & { retry: () => void };
  reload: () => Promise<void>;
}

const Ctx = createContext<PartnerPresence | null>(null);

/**
 * Delivery partner presence for the dispatch limit: own availability
 * (`/delivery/me/status`) and, while clocked in, foreground GPS reports to
 * `/delivery/me/location` so the outlet knows when they're back. Mounted once
 * around the tabs so reporting continues whichever tab is open.
 */
export function PartnerPresenceProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const { me, outlet } = useSignedIn();
  const [status, setStatus] = useState<PartnerAvailability | null>(null);
  const lastBackAt = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setStatus(await endpoints.myDeliveryStatus());
    } catch {
      // Offline: keep the last known status.
    }
  }, [enabled]);

  useEffect(() => {
    setStatus(null);
    if (!enabled) return;
    void reload();
    const poll = setInterval(() => void reload(), STATUS_POLL_MS);
    return () => clearInterval(poll);
  }, [enabled, reload, outlet?.id]);

  const sayBack = useCallback(() => {
    if (Date.now() - lastBackAt.current < BACK_DEDUPE_MS) return;
    lastBackAt.current = Date.now();
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("You're back at the outlet", "You can take new orders now.");
  }, []);

  useSocketEvent("delivery:updated", (d) => {
    if (!enabled) return;
    const p = d as { agentId?: string; backAtOutlet?: boolean } | null;
    if (p?.backAtOutlet && p.agentId === me.id) sayBack();
    void reload();
  });
  useSocketEvent("notification", () => void reload());

  const location = usePresenceLocation(enabled && !!status?.onDuty, () => {
    sayBack();
    void reload();
  });

  // Crossing the geofence changes availability: re-read it.
  const atOutlet = location.last?.atOutlet;
  useEffect(() => {
    if (atOutlet !== undefined) void reload();
  }, [atOutlet, reload]);

  const value = useMemo(() => ({ status, location, reload }), [status, location, reload]);
  return <Ctx.Provider value={enabled ? value : null}>{children}</Ctx.Provider>;
}

/** null outside a delivery partner session. */
export const usePartnerPresence = () => useContext(Ctx);

/** "At the outlet — can take N more" / "On a run…" / "Returning…" + location permission prompt. */
export function PresenceCard() {
  const t = useTheme();
  const p = usePartnerPresence();
  if (!p?.status?.onDuty) return null;
  const { status: s, location } = p;
  const st = partnerState(s);
  const room = Math.max(0, s.max - s.active);
  const distance = location.last?.distanceToOutlet ?? null;

  let icon: keyof typeof Ionicons.glyphMap = "storefront";
  let color = t.success;
  let bg = t.successBg;
  let title: string;
  let detail: string;
  if (st === "out") {
    icon = "bicycle";
    color = t.primary;
    bg = t.surfaceAlt;
    title = "On a run — deliver your orders";
    detail = `${s.outForDelivery} out for delivery. New orders unlock after you deliver them and come back to the outlet.`;
  } else if (st === "returning") {
    icon = "navigate";
    color = t.warning;
    bg = t.warningBg;
    title = `Returning — new orders unlock when you're back${distance != null ? ` (${metresText(distance)} away)` : ""}`;
    detail = "Head back to the outlet. Keep the app open so it can see you've arrived.";
  } else if (st === "available") {
    title = s.atOutlet ? `At the outlet — can take ${room} more` : `Available — can take ${room} more`;
    detail = `${s.active} of ${s.max} orders in hand.`;
  } else {
    icon = "bag-handle";
    color = t.warning;
    bg = t.warningBg;
    title = `Full — ${s.active} of ${s.max} orders`;
    detail = s.reason ?? "Pick up your orders and start the run.";
  }

  return (
    <View style={{ gap: space.sm }}>
      <View accessibilityRole="summary" style={[styles.card, { backgroundColor: bg, borderColor: color }]}>
        <Ionicons name={icon} size={28} color={color} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText style={{ fontWeight: "900" }} color={color}>
            {title}
          </AppText>
          <AppText variant="small" color={color}>
            {detail}
          </AppText>
        </View>
      </View>
      {location.permission === "denied" ? (
        <View style={{ gap: space.sm }}>
          <Notice kind="warning" title="Location is off" message="Turn on location so the outlet knows when you're back." />
          <Row>
            <Button title="Open Settings" icon="settings-outline" variant="secondary" size="md" style={{ flex: 1 }} onPress={() => void Linking.openSettings()} />
            <Button title="Try again" icon="refresh" variant="secondary" size="md" style={{ flex: 1 }} onPress={location.retry} />
          </Row>
        </View>
      ) : location.error ? (
        <Notice kind="warning" message={`Location: ${location.error}`} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: 64 },
});
