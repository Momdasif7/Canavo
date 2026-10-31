import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSignedIn } from "../../src/auth/AuthContext";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Card, Chip, EmptyState, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { HISTORY_RANGES, areaOf, historyRange, paidHow, splitNotes, type HistoryRange } from "../../src/delivery/portal";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatTime, inr, inrShort } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { Delivery, DeliverySummary } from "../../src/lib/types";
import { radius, space, useTheme, type Palette } from "../../src/theme";

const modeColor = (t: Palette, mode: string) =>
  mode === "CASH" ? t.success : mode === "UPI" ? t.info : mode === "CARD" ? t.warning : t.textMuted;

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

/** Delivery partner: delivered / cancelled orders with how each was paid, plus totals. */
function DeliveryHistory() {
  const t = useTheme();
  const { me, outlet } = useSignedIn();
  const [range, setRange] = useState<HistoryRange>("today");
  const [list, setList] = useState<Delivery[] | null>(null);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const dates = useMemo(() => historyRange(range), [range]);

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([endpoints.myDeliveryHistory(dates), endpoints.myDeliverySummary(dates)]);
      setList(l);
      setSummary(s);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [dates]);

  useEffect(() => {
    setList(null);
    setSummary(null);
    void load();
  }, [load, outlet?.id]);
  useSocketEvent("delivery:updated", () => void load());

  // Group by local day (newest first, as returned).
  const groups = useMemo(() => {
    const out: { day: string; items: Delivery[] }[] = [];
    for (const d of list ?? []) {
      const at = d.deliveredAt ?? d.updatedAt;
      const day = dayLabel(at);
      const g = out[out.length - 1];
      if (g && g.day === day) g.items.push(d);
      else out.push({ day, items: [d] });
    }
    return out;
  }, [list]);

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <AppText variant="h2">History</AppText>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {HISTORY_RANGES.map((r) => (
          <Chip key={r.value} label={r.label} selected={range === r.value} onPress={() => setRange(r.value)} />
        ))}
      </ScrollView>

      {!list && error ? <ErrorState message={error} onRetry={load} /> : null}
      {!list && !error ? (
        <View style={{ height: 240 }}>
          <Loading />
        </View>
      ) : null}
      {list && error ? <Notice kind="warning" message={`Couldn't refresh: ${error}`} /> : null}

      {summary ? (
        <Card style={{ gap: space.md }}>
          <Row style={{ justifyContent: "space-between" }}>
            <View>
              <AppText variant="small">Delivered</AppText>
              <AppText variant="price" style={{ fontSize: 28 }}>
                {summary.delivered}
              </AppText>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <AppText variant="small">Order value</AppText>
              <AppText variant="price" style={{ fontSize: 28 }}>
                {inrShort(summary.orderValue)}
              </AppText>
            </View>
          </Row>
          <View style={styles.totals}>
            {(
              [
                ["Cash collected", summary.collected.cash, "CASH"],
                ["UPI", summary.collected.upi, "UPI"],
                ["Card", summary.collected.card, "CARD"],
                ["Already paid", summary.collected.prepaid, "PREPAID"],
              ] as const
            )
              // Cash and already-paid only; older UPI / card door payments still show when present.
              .filter(([, value, mode]) => mode === "CASH" || mode === "PREPAID" || value > 0)
              .map(([label, value, mode]) => (
              <View key={label} style={[styles.total, { backgroundColor: t.surfaceAlt }]}>
                <Row style={{ gap: 6 }}>
                  <View style={[styles.dot, { backgroundColor: modeColor(t, mode) }]} />
                  <AppText variant="small">{label}</AppText>
                </Row>
                <AppText style={{ fontWeight: "800" }}>{inrShort(value)}</AppText>
              </View>
            ))}
          </View>
          {summary.cancelled ? <AppText variant="small">{summary.cancelled} cancelled</AppText> : null}
        </Card>
      ) : null}

      {list && list.length === 0 ? (
        <View style={{ height: 220 }}>
          <EmptyState icon="time-outline" title="Nothing in this period" message="Completed deliveries show up here." />
        </View>
      ) : null}

      {groups.map((g) => (
        <View key={g.day} style={{ gap: space.sm }}>
          <AppText variant="small" style={{ fontWeight: "800", textTransform: "uppercase" }}>
            {g.day}
          </AppText>
          {g.items.map((d) => {
            const cancelled = d.status === "CANCELLED";
            const how = paidHow(d.order.payments, me.id);
            const issues = splitNotes(d.notes).issues;
            return (
              <Card key={d.id} style={{ gap: space.xs, paddingVertical: space.md }}>
                <Row style={{ justifyContent: "space-between" }}>
                  <Row style={{ gap: 6, flex: 1 }}>
                    <Ionicons name={cancelled ? "close-circle" : "checkmark-circle"} size={20} color={cancelled ? t.danger : t.success} />
                    <AppText style={{ fontWeight: "800" }}>{formatTime(d.deliveredAt ?? d.updatedAt)}</AppText>
                    <AppText variant="small" numberOfLines={1}>
                      · {d.order.invoiceNumber}
                    </AppText>
                  </Row>
                  <AppText variant="price" style={{ textDecorationLine: cancelled ? "line-through" : "none" }}>
                    {inr(d.order.grandTotal)}
                  </AppText>
                </Row>
                <AppText style={{ fontWeight: "700" }}>{d.customerName}</AppText>
                <AppText variant="small" numberOfLines={1}>
                  {areaOf(d.address)}
                </AppText>
                {cancelled ? (
                  <AppText variant="small" color={t.danger} style={{ fontWeight: "700" }}>
                    Cancelled
                  </AppText>
                ) : (
                  <Row style={{ flexWrap: "wrap", gap: 6 }}>
                    {how.length ? (
                      how.map((h, i) => (
                        <View key={i} style={[styles.tag, { borderColor: modeColor(t, h.mode) }]}>
                          <AppText variant="small" style={{ fontWeight: "700", color: modeColor(t, h.mode) }}>
                            {h.label}
                          </AppText>
                        </View>
                      ))
                    ) : (
                      <AppText variant="small">Payment pending at outlet</AppText>
                    )}
                  </Row>
                )}
                {issues.length ? (
                  <AppText variant="small" color={t.danger}>
                    ⚠ {issues.join(" · ")}
                  </AppText>
                ) : null}
              </Card>
            );
          })}
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  totals: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  total: { flexGrow: 1, minWidth: "45%", borderRadius: radius.md, padding: space.sm, gap: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tag: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
});

export default withAccess(["delivery:own"], DeliveryHistory);
