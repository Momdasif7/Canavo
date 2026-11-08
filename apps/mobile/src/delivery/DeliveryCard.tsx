import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { MiniMap } from "./MiniMap";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { AppText, Card, Row } from "../components/ui";
import { formatTime, humanize, inr } from "../lib/format";
import type { Delivery, DeliveryStatus } from "../lib/types";
import { font, radius, space, TAP, useTheme, type Palette } from "../theme";
import { etaCountdown, splitNotes } from "./portal";

export function deliveryStatusColor(t: Palette, s: DeliveryStatus) {
  switch (s) {
    case "PENDING":
      return t.info;
    case "ACCEPTED":
    case "PREPARING":
      return t.warning;
    case "OUT_FOR_DELIVERY":
      return t.primary;
    case "DELIVERED":
      return t.success;
    default:
      return t.textMuted;
  }
}

/** Next step the agent can take (the server allows forward moves only). */
export function nextAgentStep(s: DeliveryStatus): { status: DeliveryStatus; label: string; icon: keyof typeof Ionicons.glyphMap } | null {
  if (s === "PENDING") return { status: "ACCEPTED", label: "Accept delivery", icon: "hand-left-outline" };
  if (s === "ACCEPTED" || s === "PREPARING") return { status: "OUT_FOR_DELIVERY", label: "Picked up · Start delivery", icon: "bicycle" };
  if (s === "OUT_FOR_DELIVERY") return { status: "DELIVERED", label: "Deliver", icon: "checkmark-done" };
  return null;
}

export function mapsUrl(d: Pick<Delivery, "latitude" | "longitude" | "address" | "landmark" | "pincode">) {
  // No pin (address-only delivery): search the typed address, landmark and PIN code.
  const dest =
    d.latitude != null && d.longitude != null
      ? `${d.latitude},${d.longitude}`
      : encodeURIComponent([d.address, d.landmark, d.pincode].filter(Boolean).join(", "));
  // Universal link: opens the Google Maps app when installed, else the browser.
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

/** Re-render every `ms` (ETA countdowns). */
export function useTick(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function StatusPill({ status }: { status: DeliveryStatus }) {
  const t = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: deliveryStatusColor(t, status) }]}>
      <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{humanize(status)}</AppText>
    </View>
  );
}

export function IconAction({
  icon,
  label,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: string;
}) {
  const t = useTheme();
  const color = tone ?? t.primary;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.action, { borderColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface }]}
    >
      <Ionicons name={icon} size={22} color={color} />
      <AppText style={{ fontWeight: "800", color }}>{label}</AppText>
    </Pressable>
  );
}

/** Cash on Delivery with money still due. */
export const isCodDue = (d: Pick<Delivery, "cod" | "amountDue">) => !!d.cod && d.amountDue > 0;

/** Small "COD ₹X" pill (card header / manager board). */
export function CodPill({ d }: { d: Delivery }) {
  const t = useTheme();
  if (!isCodDue(d)) return null;
  return (
    <View style={[styles.pill, styles.codPill, { backgroundColor: t.warning }]} accessibilityLabel={`Cash on delivery, ${inr(d.amountDue)}`}>
      <Ionicons name="cash" size={14} color="#fff" />
      <AppText style={{ color: "#fff", fontWeight: "900", fontSize: 12 }}>COD {inr(d.amountDue)}</AppText>
    </View>
  );
}

/** "Collect ₹X cash" (amber, big) when money is due, else PAID (green). */
export function PaymentBadge({ d, large }: { d: Delivery; large?: boolean }) {
  const t = useTheme();
  const collect = d.amountDue > 0;
  const cod = isCodDue(d);
  if (collect) {
    return (
      <View
        style={[styles.collect, { backgroundColor: t.warningBg, borderColor: t.warning, paddingVertical: large ? space.md : space.sm }]}
        accessibilityRole="summary"
        accessibilityLabel={`${cod ? "Cash on delivery. " : ""}Collect ${inr(d.amountDue)} cash`}
      >
        <Row style={{ gap: 6 }}>
          <Ionicons name="cash" size={large ? 22 : 18} color={t.warning} />
          <AppText style={{ fontWeight: "800", color: t.warning }}>{cod ? "Cash on delivery" : "Not paid yet"}</AppText>
        </Row>
        <AppText style={{ fontWeight: "900", fontSize: large ? font.xxl : font.xl, color: t.warning, fontVariant: ["tabular-nums"] }}>
          Collect {inr(d.amountDue)} cash
        </AppText>
      </View>
    );
  }
  return (
    <View style={[styles.due, { backgroundColor: t.successBg, paddingVertical: large ? space.md : space.sm }]} accessibilityLabel="Already paid">
      <Ionicons name="checkmark-circle" size={large ? 26 : 20} color={t.success} />
      <AppText style={{ fontWeight: "900", fontSize: large ? font.xl : font.lg, color: t.success, flexShrink: 1 }}>PAID · nothing to collect</AppText>
      <AppText variant="small" color={t.success}>
        {inr(d.order.grandTotal)}
      </AppText>
    </View>
  );
}

/** Partner-reported problems ("ISSUE: …" note lines) — shown prominently. */
export function IssueNotes({ notes }: { notes: string | null | undefined }) {
  const t = useTheme();
  const { issues } = splitNotes(notes);
  if (!issues.length) return null;
  return (
    <View style={[styles.issue, { backgroundColor: t.dangerBg, borderColor: t.danger }]} accessibilityRole="alert">
      <Ionicons name="warning" size={22} color={t.danger} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ color: t.danger, fontWeight: "900" }}>Problem reported</AppText>
        {issues.map((i, n) => (
          <AppText key={n} style={{ color: t.danger, fontWeight: "600" }}>
            {i}
          </AppText>
        ))}
      </View>
    </View>
  );
}

/**
 * Customer, address, items, ETA and payment badge with Call / Navigate.
 * `children` renders the status controls. `showAgent` for the manager board.
 */
export function DeliveryCard({
  d,
  children,
  remainingKm,
  showAgent = true,
  showMap = false,
}: {
  d: Delivery;
  children?: React.ReactNode;
  remainingKm?: number | null;
  showAgent?: boolean;
  /** Read-only mini map with the customer's pin (partner app); tap → navigation */
  showMap?: boolean;
}) {
  const t = useTheme();
  const now = useTick();
  const done = d.status === "DELIVERED" || d.status === "CANCELLED";
  const eta = done ? null : etaCountdown(d.etaAt, now);
  const { other } = splitNotes(d.notes);
  return (
    <Card style={{ gap: space.md, borderLeftWidth: 6, borderLeftColor: deliveryStatusColor(t, d.status), opacity: done ? 0.75 : 1 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <AppText variant="h3">{d.order.invoiceNumber}</AppText>
          {eta ? (
            <Row style={{ gap: 4 }}>
              <Ionicons name={eta.late ? "alarm" : "time-outline"} size={16} color={eta.late ? t.danger : t.textMuted} />
              <AppText style={{ fontWeight: "800", color: eta.late ? t.danger : t.textMuted }}>
                ETA {formatTime(d.etaAt!)} · {eta.text}
              </AppText>
            </Row>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <StatusPill status={d.status} />
          <CodPill d={d} />
        </View>
      </Row>

      <IssueNotes notes={d.notes} />

      <View style={{ gap: 2 }}>
        <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{d.customerName}</AppText>
        <AppText>{d.address}</AppText>
        {d.landmark ? <AppText variant="muted">Near {d.landmark}</AppText> : null}
        {d.pincode ? <AppText variant="muted">PIN {d.pincode}</AppText> : null}
        <AppText variant="small">
          {[
            d.distanceKm != null ? `${d.distanceKm} km` : null,
            remainingKm != null ? `${remainingKm} km to go` : null,
            showAgent ? (d.agent ? `Agent ${d.agent.name}` : "No agent") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </AppText>
      </View>

      {showMap && !done && d.latitude != null && d.longitude != null ? (
        <MiniMap pin={{ lat: d.latitude, lng: d.longitude }} label="Exact location · tap to navigate" onPress={() => void Linking.openURL(mapsUrl(d))} />
      ) : null}

      {!done ? (
        <Row>
          <IconAction icon="call" label="Call" onPress={() => void Linking.openURL(`tel:${d.customerPhone}`)} />
          <IconAction icon="navigate" label="Navigate" onPress={() => void Linking.openURL(mapsUrl(d))} />
        </Row>
      ) : null}

      <View style={[styles.items, { backgroundColor: t.surfaceAlt }]}>
        {d.order.items.map((i, n) => (
          <View key={n}>
            <AppText style={{ fontWeight: "700" }}>
              {i.quantity} × {i.name}
            </AppText>
            {i.notes ? <AppText variant="small" color={t.warning}>↳ {i.notes}</AppText> : null}
          </View>
        ))}
        {d.order.notes ? <AppText variant="small" color={t.warning}>Order note: {d.order.notes}</AppText> : null}
        {other.length ? <AppText variant="small">{other.join("\n")}</AppText> : null}
      </View>

      {!done ? <PaymentBadge d={d} large /> : null}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  codPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  action: {
    flex: 1,
    minHeight: TAP,
    borderWidth: 1,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  collect: { borderRadius: radius.md, borderWidth: 2, paddingHorizontal: space.md, alignItems: "center", gap: 2 },
  due: { borderRadius: radius.md, paddingHorizontal: space.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  items: { borderRadius: radius.md, padding: space.md, gap: 4 },
  issue: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, alignItems: "flex-start" },
});
