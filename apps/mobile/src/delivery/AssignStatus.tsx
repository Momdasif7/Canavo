import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppText } from "../components/ui";
import { endpoints } from "../lib/api";
import { useSocketEvent } from "../lib/socket";
import type { Order } from "../lib/types";
import { radius, space, useTheme } from "../theme";
import { assignedPartner, assignmentLabel } from "./assign";

/**
 * After a delivery order is placed: who's taking it. The API auto-assigns an
 * available partner (at the outlet, under the per-partner limit) when none was
 * picked; otherwise the order waits and is given to the next partner who's
 * back — this card updates live.
 */
export function AssignStatus({ order }: { order: Order }) {
  const t = useTheme();
  const [current, setCurrent] = useState(order);
  useEffect(() => setCurrent(order), [order]);

  const refresh = () => {
    endpoints
      .getOrder(order.id)
      .then(setCurrent)
      .catch(() => undefined);
  };
  useSocketEvent("delivery:updated", (d) => {
    const p = d as { id?: string; orderId?: string } | null;
    if (!p || p.orderId === order.id || p.id === order.delivery?.id || !p.orderId) refresh();
  });

  const delivery = current.delivery;
  if (!delivery || delivery.status === "CANCELLED") return null;
  const partner = assignedPartner(current);
  return (
    <View
      accessibilityRole="summary"
      style={[styles.box, { backgroundColor: partner ? t.successBg : t.warningBg, borderColor: partner ? t.success : t.warning }]}
    >
      <Ionicons name={partner ? "bicycle" : "hourglass-outline"} size={26} color={partner ? t.success : t.warning} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontWeight: "900" }} color={partner ? t.success : t.warning}>
          {assignmentLabel(current)}
        </AppText>
        <AppText variant="small" color={partner ? t.success : t.warning}>
          {partner
            ? "They've been notified on their phone."
            : "No partner is free right now. It's auto-assigned when one is back at the outlet, or assign one from the Delivery board."}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: 64 },
});
