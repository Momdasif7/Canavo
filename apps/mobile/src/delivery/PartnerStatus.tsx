import React, { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { AppText, Button } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { useSocketEvent } from "../lib/socket";
import type { DeliveryAgent, PartnerAvailability } from "../lib/types";
import { radius, useTheme } from "../theme";
import { canMarkBack, partnerBadge, partnerState } from "./portal";

/** Dispatch availability of every partner (GET /delivery/agents), live on `delivery:updated`. */
export function usePartnerAvailability(outletId: string | null) {
  const [agents, setAgents] = useState<DeliveryAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await endpoints.deliveryAgents());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setAgents(null);
    void load();
    const poll = setInterval(load, 30_000);
    return () => clearInterval(poll);
  }, [load, outletId]);
  useSocketEvent("delivery:updated", () => void load());

  return { agents, error, load };
}

/** Pill: Available / 2 of 2 / Out for delivery / Returning / Off duty. */
export function PartnerBadge({ a }: { a: PartnerAvailability }) {
  const t = useTheme();
  const st = partnerState(a);
  const [bg, fg] =
    st === "available" ? [t.successBg, t.success] : st === "off" ? [t.surfaceAlt, t.textMuted] : st === "out" ? [t.surfaceAlt, t.primary] : [t.warningBg, t.warning];
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: fg }]} accessibilityLabel={`Status: ${partnerBadge(a)}${a.reason ? `. ${a.reason}` : ""}`}>
      <AppText style={{ fontWeight: "800", fontSize: 12 }} color={fg}>
        {partnerBadge(a)}
      </AppText>
    </View>
  );
}

/**
 * "Mark back at outlet" — manager override when a partner's GPS hasn't
 * reported them back (only shown when on duty, away, nothing still out).
 */
export function MarkBackButton({ a, onDone }: { a: PartnerAvailability; onDone?: (next: PartnerAvailability) => void }) {
  const [busy, setBusy] = useState(false);
  if (!canMarkBack(a)) return null;
  const run = async () => {
    setBusy(true);
    try {
      const next = await endpoints.markPartnerBack(a.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDone?.(next);
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Couldn't mark back", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      title="Mark back at outlet"
      icon="home-outline"
      variant="secondary"
      size="md"
      loading={busy}
      onPress={() =>
        Alert.alert("Mark back at outlet?", `${a.name} can take new orders right away. Waiting orders may be auto-assigned to them.`, [
          { text: "Cancel", style: "cancel" },
          { text: "Mark back", onPress: () => void run() },
        ])
      }
    />
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, alignSelf: "flex-start" },
});
