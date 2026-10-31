import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSignedIn } from "../../src/auth/AuthContext";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Card, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { areaOf } from "../../src/delivery/portal";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatDate, formatTime, inr } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { MyCash } from "../../src/lib/types";
import { brand, font, radius, space, TAP, useTheme } from "../../src/theme";

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? `Today ${formatTime(iso)}` : `${formatDate(iso)} · ${formatTime(iso)}`;
};

/**
 * Delivery partner: cash to hand over, kept apart from deliveries. Balance =
 * cash collected at the door − handovers the cashier / manager recorded.
 */
function PartnerCashScreen() {
  const t = useTheme();
  const { outlet } = useSignedIn();
  const [cash, setCash] = useState<MyCash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCash(await endpoints.myCash());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setCash(null);
    void load();
  }, [load, outlet?.id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useSocketEvent("delivery:updated", () => void load());
  useSocketEvent("notification", () => void load());

  if (!cash && error) return <Screen scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!cash) return <Screen scroll={false}><Loading label="Loading your cash…" /></Screen>;

  const holding = cash.balance > 0;
  const fg = holding ? "#fff" : t.success;
  const pending = [...cash.pending].sort((a, b) => (a.collectedAt ?? "").localeCompare(b.collectedAt ?? ""));

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <AppText variant="h2">Cash</AppText>
      {error ? <Notice kind="warning" message={`Couldn't refresh: ${error}`} /> : null}

      <View style={[styles.hero, { backgroundColor: holding ? brand.saffron : t.successBg }]} accessibilityRole="summary">
        <Row style={{ gap: space.sm }}>
          <Ionicons name="wallet" size={26} color={fg} />
          <AppText style={{ fontWeight: "800", fontSize: font.lg, color: fg }}>Cash to hand over</AppText>
        </Row>
        <AppText variant="priceLg" style={{ color: fg, fontSize: 48 }}>
          {inr(Math.max(0, cash.balance))}
        </AppText>
        <AppText style={{ color: fg, fontWeight: "600" }}>
          {holding
            ? `From ${pending.length} order${pending.length === 1 ? "" : "s"}. Hand this cash to the cashier/manager — they'll record it.`
            : cash.balance < 0
              ? `You've handed over ${inr(-cash.balance)} more than you collected. The outlet will adjust it.`
              : "Nothing to hand over. All settled."}
        </AppText>
      </View>

      <Row style={{ alignItems: "stretch" }}>
        <Card style={[styles.stat, { borderColor: t.border }]}>
          <Row style={{ gap: 6 }}>
            <Ionicons name="arrow-down-circle-outline" size={18} color={t.warning} />
            <AppText variant="small">Collected today</AppText>
          </Row>
          <AppText variant="price" style={{ fontSize: font.xl }}>
            {inr(cash.collectedToday)}
          </AppText>
        </Card>
        <Card style={[styles.stat, { borderColor: t.border }]}>
          <Row style={{ gap: 6 }}>
            <Ionicons name="arrow-up-circle-outline" size={18} color={t.success} />
            <AppText variant="small">Handed over today</AppText>
          </Row>
          <AppText variant="price" style={{ fontSize: font.xl }}>
            {inr(cash.handedOverToday)}
          </AppText>
        </Card>
      </Row>

      <Card style={{ gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="h3">Orders not handed over</AppText>
          <AppText variant="small">Oldest first</AppText>
        </Row>
        {pending.length === 0 ? <AppText variant="muted">No cash pending.</AppText> : null}
        {pending.map((p, i) => (
          <View key={`${p.orderId}-${i}`} style={[styles.line, { borderColor: t.border }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <AppText style={{ fontWeight: "800" }}>
                {p.invoiceNumber}
                {p.customerName ? ` · ${p.customerName}` : ""}
              </AppText>
              <AppText variant="small" numberOfLines={1}>
                {[p.collectedAt ? when(p.collectedAt) : null, p.address ? areaOf(p.address) : null].filter(Boolean).join(" · ")}
              </AppText>
            </View>
            <AppText variant="price" color={t.warning}>
              {inr(p.amount)}
            </AppText>
          </View>
        ))}
      </Card>

      <Card style={{ gap: space.sm }}>
        <AppText variant="h3">Handover history</AppText>
        {cash.handovers.length === 0 ? <AppText variant="muted">No handovers recorded yet.</AppText> : null}
        {cash.handovers.map((h) => (
          <View key={h.id} style={[styles.line, { borderColor: t.border }]}>
            <Ionicons name="checkmark-circle" size={22} color={t.success} />
            <View style={{ flex: 1, gap: 2 }}>
              <AppText style={{ fontWeight: "700" }}>{when(h.receivedAt)}</AppText>
              <AppText variant="small">
                Received by {h.receivedBy?.name ?? "outlet"}
                {h.note ? ` · ${h.note}` : ""}
              </AppText>
            </View>
            <AppText variant="price" color={t.success}>
              {inr(h.amount)}
            </AppText>
          </View>
        ))}
      </Card>
      <AppText variant="small" style={{ textAlign: "center" }}>
        Wrong amount? Ask the cashier or manager — only they can correct handovers.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  stat: { flex: 1, gap: 4 },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm },
});

export default withAccess(["delivery:own"], PartnerCashScreen);
