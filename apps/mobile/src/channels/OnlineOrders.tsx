import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Chip, Input, Notice, Row } from "../components/ui";
import { errorMessage } from "../lib/api";
import { inr } from "../lib/format";
import type { ChannelBoardOrder, ChannelRequest } from "../lib/types";
import { font, radius, space, useTheme } from "../theme";
import { ageLabel, channelBadge, firstName, REJECT_REASONS, rejectReasonText, REQUEST_PAYMENT_LABEL, type RejectReason } from "./board";

export function ChannelBadge({ channel }: { channel: string }) {
  const b = channelBadge(channel);
  return (
    <View style={[styles.tag, { backgroundColor: b.color }]} accessibilityLabel={`${b.label} order`}>
      <AppText style={styles.tagText}>{b.label.toUpperCase()}</AppText>
    </View>
  );
}

function Pill({ label, color, bg, icon }: { label: string; color: string; bg: string; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={14} color={color} /> : null}
      <AppText style={{ color, fontWeight: "800", fontSize: font.sm }}>{label}</AppText>
    </View>
  );
}

// ---------- Board card ----------

export function BoardOrderCard({
  order: o,
  now,
  busy,
  onPacked,
  onHandover,
}: {
  order: ChannelBoardOrder;
  now: number;
  busy: boolean;
  /** Shown on New / Preparing */
  onPacked?: () => void;
  /** Shown on Packed */
  onHandover?: () => void;
}) {
  const t = useTheme();
  const name = firstName(o.customerName);
  const ageMin = (now - new Date(o.placedAt).getTime()) / 60_000;
  const active = o.stage === "NEW" || o.stage === "PREPARING";
  const timerColor = !active ? t.textMuted : ageMin >= 20 ? t.danger : ageMin >= 10 ? t.warning : t.success;
  const border = o.stage === "NEW" ? t.info : o.stage === "PREPARING" ? t.warning : o.stage === "PACKED" ? t.success : t.border;
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: border }]}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row style={{ gap: space.sm, flexShrink: 1 }}>
          <ChannelBadge channel={o.channel} />
          <AppText variant="h3" numberOfLines={1} style={{ flexShrink: 1 }}>
            {o.invoiceNumber}
          </AppText>
        </Row>
        <Row style={{ gap: 4 }}>
          <Ionicons name="timer-outline" size={18} color={timerColor} />
          <AppText style={{ color: timerColor, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{ageLabel(o.placedAt, now)}</AppText>
        </Row>
      </Row>
      <AppText variant="muted" numberOfLines={1}>
        {o.channelOrderId ? `#${o.channelOrderId}` : "No channel order id"}
        {name ? ` · ${name}` : ""}
        {o.weDeliver ? " · We deliver" : ""}
      </AppText>

      <View style={{ gap: 2, marginVertical: space.sm }}>
        {o.items.map((it, i) => (
          <View key={i}>
            <AppText style={{ fontSize: font.lg, fontWeight: "700" }}>
              {it.quantity} × {it.name}
            </AppText>
            {it.notes ? (
              <AppText color={t.danger} style={{ marginLeft: space.lg, fontWeight: "700" }}>
                ! {it.notes}
              </AppText>
            ) : null}
          </View>
        ))}
      </View>

      <Row style={{ flexWrap: "wrap" }}>
        {o.paid ? (
          <Pill label="PAID ONLINE" color={t.success} bg={t.successBg} icon="checkmark-circle" />
        ) : (
          <Pill label={`COLLECT ${inr(o.total)}`} color={t.danger} bg={t.dangerBg} icon="cash-outline" />
        )}
        {o.rider?.arrived ? <Pill label="RIDER ARRIVED" color="#fff" bg={t.success} icon="bicycle" /> : null}
      </Row>

      {o.rider ? (
        <View style={[styles.rider, { backgroundColor: t.surfaceAlt }]}>
          <Ionicons name="bicycle-outline" size={20} color={t.textMuted} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontWeight: "700" }} numberOfLines={1}>
              {o.rider.name ?? "Rider not assigned yet"}
              {o.rider.eta && !o.rider.arrived ? ` · ETA ${o.rider.eta}` : ""}
            </AppText>
            {o.rider.phone ? <AppText variant="small">{o.rider.phone}</AppText> : null}
          </View>
          {o.rider.pickupCode ? (
            <View accessibilityLabel={`Pickup code ${o.rider.pickupCode}`} style={{ alignItems: "flex-end" }}>
              <AppText variant="small">Pickup code</AppText>
              <AppText style={{ fontSize: font.xl, fontWeight: "900", letterSpacing: 2, fontVariant: ["tabular-nums"] }}>
                {o.rider.pickupCode}
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}

      {o.stage === "HANDED_OVER" && o.handedOverAt ? (
        <AppText variant="small">Handed over {ageLabel(o.handedOverAt, now)} ago</AppText>
      ) : null}

      {onPacked && active ? (
        <Button title="Packed" icon="cube-outline" variant="success" size="md" loading={busy} onPress={onPacked} style={{ marginTop: space.sm }} />
      ) : null}
      {onHandover && o.stage === "PACKED" ? (
        <Button title="Handed to rider" icon="bicycle" size="md" loading={busy} onPress={onHandover} style={{ marginTop: space.sm }} />
      ) : null}
    </View>
  );
}

// ---------- "Waiting for you" (QR / online requests) ----------

export function RequestCard({
  request: r,
  now,
  busy,
  onAccept,
  onReject,
}: {
  request: ChannelRequest;
  now: number;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const t = useTheme();
  const name = firstName(r.customerName);
  const where = r.channel === "QR" ? (r.tableLabel ? `Table ${r.tableLabel}` : "Table") : (r.order?.orderType ?? "").replace(/_/g, " ").toLowerCase();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.warning }]}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row style={{ gap: space.sm, flexShrink: 1 }}>
          <ChannelBadge channel={r.channel} />
          <AppText variant="h3" numberOfLines={1} style={{ flexShrink: 1, textTransform: r.channel === "QR" ? "none" : "capitalize" }}>
            {where || "Online order"}
          </AppText>
        </Row>
        <AppText style={{ color: t.warning, fontWeight: "900" }}>{ageLabel(r.createdAt, now)}</AppText>
      </Row>
      <AppText variant="muted" numberOfLines={1}>
        {[r.order?.invoiceNumber, name, r.payment ? REQUEST_PAYMENT_LABEL[r.payment] : null].filter(Boolean).join(" · ") || "New order"}
      </AppText>
      <View style={{ gap: 2, marginVertical: space.sm }}>
        {r.items.map((it, i) => (
          <View key={i}>
            <AppText style={{ fontWeight: "700" }}>
              {it.quantity} × {it.name}
            </AppText>
            {it.notes ? (
              <AppText color={t.danger} style={{ marginLeft: space.lg }}>
                ! {it.notes}
              </AppText>
            ) : null}
          </View>
        ))}
        {r.notes ? <AppText color={t.danger}>Note: {r.notes}</AppText> : null}
      </View>
      <Row style={{ justifyContent: "space-between" }}>
        <AppText variant="price">{inr(r.order?.grandTotal ?? r.total)}</AppText>
      </Row>
      <Row style={{ marginTop: space.sm }}>
        <Button title="Reject" icon="close" variant="secondary" size="md" disabled={busy} onPress={onReject} style={{ flex: 1 }} />
        <Button title="Accept" icon="checkmark" variant="success" size="md" loading={busy} onPress={onAccept} style={{ flex: 2 }} />
      </Row>
    </View>
  );
}

export function RejectSheet({
  request,
  onClose,
  onReject,
}: {
  request: ChannelRequest | null;
  onClose: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<RejectReason | null>(null);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChoice(null);
    setOther("");
    setError(null);
  }, [request?.id]);
  const reason = rejectReasonText(choice, other);
  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await onReject(reason);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={!!request} onClose={onClose} title="Reject this order?">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <AppText variant="muted">
          {request?.channel === "QR" ? "The guest sees the reason on their phone." : "The customer sees the reason and the bill is cancelled."}
        </AppText>
        <Row style={{ flexWrap: "wrap" }}>
          {REJECT_REASONS.map((r) => (
            <Chip key={r} label={r} selected={choice === r} onPress={() => setChoice(r)} />
          ))}
        </Row>
        {choice === "Other" ? (
          <Input label="Reason" placeholder="Tell the customer why" value={other} onChangeText={setOther} maxLength={200} autoFocus />
        ) : null}
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Reject order" icon="close-circle" variant="danger" disabled={!reason} loading={busy} onPress={submit} />
        <Button title="Keep it" variant="ghost" onPress={onClose} />
      </ScrollView>
    </Sheet>
  );
}

export function HandoverSheet({
  order,
  onClose,
  onHandover,
}: {
  order: ChannelBoardOrder | null;
  onClose: () => void;
  onHandover: (riderName?: string) => Promise<void>;
}) {
  const [rider, setRider] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRider(order?.rider?.name ?? "");
    setError(null);
  }, [order?.orderId, order?.rider?.name]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onHandover(rider.trim() || undefined);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={!!order} onClose={onClose} title="Hand to rider">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        {order ? (
          <Row>
            <ChannelBadge channel={order.channel} />
            <AppText variant="h3">{order.invoiceNumber}</AppText>
          </Row>
        ) : null}
        {order?.rider?.pickupCode ? <Notice kind="info" message={`Check the rider's pickup code: ${order.rider.pickupCode}`} /> : null}
        {order && !order.paid ? <Notice kind="warning" message={`Collect ${inr(order.total)} for this order.`} /> : null}
        <Input label="Rider name (optional)" placeholder="e.g. Ravi" value={rider} onChangeText={setRider} maxLength={80} />
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Handed to rider" icon="bicycle" loading={busy} onPress={submit} />
        <Button title="Cancel" variant="ghost" onPress={onClose} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 2, borderLeftWidth: 8, padding: space.lg, gap: 4 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm },
  tagText: { color: "#fff", fontWeight: "900", fontSize: font.sm, letterSpacing: 0.5 },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  rider: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, marginTop: space.sm },
});
