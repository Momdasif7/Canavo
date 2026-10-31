import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Card, EmptyState, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { MarkBackButton, PartnerBadge, usePartnerAvailability } from "../../src/delivery/PartnerStatus";
import { RecordHandoverSheet, type HandoverTarget } from "../../src/delivery/RecordHandoverSheet";
import { periodRange } from "../../src/delivery/portal";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatTime, inr } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { PartnerActivityRow } from "../../src/lib/types";
import { font, radius, space, TAP, useTheme } from "../../src/theme";

/** Manager (delivery:manage): every delivery partner with cash to receive now and today's activity. */
function DeliveryPartners() {
  const t = useTheme();
  const { outlet } = useSignedIn();
  const [rows, setRows] = useState<PartnerActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState<HandoverTarget | null>(null);
  const [done, setDone] = useState<{ message: string; warnings?: string[] } | null>(null);
  const availability = usePartnerAvailability(outlet?.id ?? null);

  const load = useCallback(async () => {
    try {
      const res = await endpoints.partnerActivity(periodRange("today"));
      setRows(res.partners);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setRows(null);
  }, [outlet?.id]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useSocketEvent("delivery:updated", () => void load());

  if (!rows && error) return <Screen edges={[]} scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!rows) return <Screen edges={[]} scroll={false}><Loading label="Loading partners…" /></Screen>;

  const sorted = [...rows].sort((a, b) => b.currentBalance - a.currentBalance || a.agent.name.localeCompare(b.agent.name));
  const total = rows.reduce((s, r) => s + Math.max(0, r.currentBalance), 0);
  const today = rows.reduce(
    (s, r) => ({ collected: s.collected + r.totals.cashCollected, received: s.received + r.totals.cashReceived, delivered: s.delivered + r.totals.delivered }),
    { collected: 0, received: 0, delivered: 0 },
  );

  return (
    <Screen
      edges={[]}
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await Promise.all([load(), availability.load()]);
        setRefreshing(false);
      }}
    >
      <Card style={{ gap: space.xs }}>
        <AppText variant="small">Cash to receive from partners</AppText>
        <AppText variant="priceLg" color={total > 0 ? t.warning : t.success}>
          {inr(total)}
        </AppText>
        <AppText variant="small">
          Today: collected {inr(today.collected)} · received {inr(today.received)} · {today.delivered} delivered
        </AppText>
      </Card>
      {error ? <Notice kind="warning" message={`Couldn't refresh: ${error}`} /> : null}
      {done ? <Notice kind="success" message={done.message} /> : null}
      {done?.warnings?.map((w) => <Notice key={w} kind="warning" message={w} />)}

      {sorted.length === 0 ? (
        <View style={{ height: 240 }}>
          <EmptyState icon="bicycle-outline" title="No delivery partners" message="Add staff with the Delivery role to this outlet on the web dashboard." />
        </View>
      ) : null}

      {sorted.map((r) => {
        const day = r.days[r.days.length - 1];
        const onDuty = !!day?.clockIn && !day.clockOut;
        const holds = r.currentBalance > 0;
        const avail = availability.agents?.find((a) => a.id === r.agent.id) ?? null;
        return (
          <Card key={r.agent.id} style={{ gap: space.sm, opacity: r.agent.status === "ACTIVE" ? 1 : 0.7 }}>
            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                router.push({ pathname: "/delivery-partners/[agentId]", params: { agentId: r.agent.id, name: r.agent.name } });
              }}
              accessibilityRole="button"
              accessibilityLabel={`${r.agent.name}, ${inr(r.currentBalance)} to receive. Open activity`}
              style={styles.head}
            >
              <View style={[styles.dot, { backgroundColor: onDuty ? t.success : t.textMuted }]} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{r.agent.name}</AppText>
                {avail ? <PartnerBadge a={avail} /> : null}
                <AppText variant="small">
                  {onDuty ? `On duty since ${formatTime(day!.clockIn!)}` : day?.clockIn ? `Off duty · ${formatTime(day.clockIn)}–${day.clockOut ? formatTime(day.clockOut) : "…"}` : "Not clocked in today"}
                  {r.agent.status !== "ACTIVE" ? " · inactive" : ""}
                </AppText>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <AppText variant="small">To receive</AppText>
                <AppText variant="price" style={{ fontSize: font.xl, fontWeight: "900" }} color={holds ? t.warning : t.success}>
                  {inr(r.currentBalance)}
                </AppText>
              </View>
              <Ionicons name="chevron-forward" size={22} color={t.textMuted} />
            </Pressable>
            <Row style={{ justifyContent: "space-between" }}>
              <Stat label="Collected today" value={inr(r.totals.cashCollected)} />
              <Stat label="Received today" value={inr(r.totals.cashReceived)} />
              <Stat label="Delivered" value={String(r.totals.delivered)} />
            </Row>
            {avail ? <MarkBackButton a={avail} onDone={() => void availability.load()} /> : null}
            {holds ? (
              <Pressable
                onPress={() => {
                  setDone(null);
                  setRecording({ agent: r.agent, balance: r.currentBalance });
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.record, { backgroundColor: pressed ? t.surfaceAlt : t.successBg, borderColor: t.success }]}
              >
                <Ionicons name="cash-outline" size={20} color={t.success} />
                <AppText style={{ fontWeight: "800" }} color={t.success}>
                  Record cash received
                </AppText>
              </Pressable>
            ) : null}
          </Card>
        );
      })}

      <RecordHandoverSheet
        target={recording}
        onClose={() => setRecording(null)}
        onSaved={(message, warnings) => {
          setRecording(null);
          setDone({ message, warnings });
          void load();
        }}
      />
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <AppText variant="small">{label}</AppText>
      <AppText style={{ fontWeight: "800" }}>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP },
  dot: { width: 12, height: 12, borderRadius: 6 },
  record: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, minHeight: TAP, borderWidth: 1.5, borderRadius: radius.md },
});

export default withAccess(["delivery:manage"], DeliveryPartners);
