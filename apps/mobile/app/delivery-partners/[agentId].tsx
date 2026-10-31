import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Chip, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { MarkBackButton, PartnerBadge, usePartnerAvailability } from "../../src/delivery/PartnerStatus";
import { RecordHandoverSheet, type HandoverTarget } from "../../src/delivery/RecordHandoverSheet";
import { TimelineSheet, dayTitle } from "../../src/delivery/TimelineSheet";
import { ACTIVITY_PERIODS, periodRange, type Period } from "../../src/delivery/portal";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatDate, formatMinutes, formatTime, inr } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { CashHandover, PartnerActivityDay, PartnerActivityRow } from "../../src/lib/types";
import { font, radius, space, TAP, useTheme } from "../../src/theme";

/** Manager: one partner's days (duty, deliveries, cash collected / received / to receive), timeline and handovers. */
function PartnerDetail() {
  const t = useTheme();
  const params = useLocalSearchParams<{ agentId: string; name?: string }>();
  const agentId = String(params.agentId);
  const [period, setPeriod] = useState<Period>("today");
  const range = useMemo(() => periodRange(period), [period]);
  const [row, setRow] = useState<PartnerActivityRow | null>(null);
  const [handovers, setHandovers] = useState<CashHandover[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [recording, setRecording] = useState<HandoverTarget | null>(null);
  const [timeline, setTimeline] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; warnings?: string[] } | null>(null);
  const availability = usePartnerAvailability(null);
  const avail = availability.agents?.find((a) => a.id === agentId) ?? null;

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([endpoints.partnerActivity({ ...range, agentId }), endpoints.cashHandovers({ ...range, agentId })]);
      setRow(a.partners.find((p) => p.agent.id === agentId) ?? null);
      setHandovers(h);
      setError(a.partners.some((p) => p.agent.id === agentId) ? null : "Delivery partner not found in this outlet");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [range, agentId]);

  useEffect(() => {
    setRow(null);
    setHandovers(null);
    void load();
  }, [load]);
  useSocketEvent("delivery:updated", () => void load());

  const name = row?.agent.name ?? params.name ?? "Partner";
  const agent = { id: agentId, name };
  const balance = row?.currentBalance ?? 0;

  const remove = (h: CashHandover) => {
    Alert.alert("Delete handover?", `${inr(h.amount)} received ${formatDate(h.receivedAt)} ${formatTime(h.receivedAt)}. ${name} will hold this cash again.`, [
      { text: "Keep", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setActionError(null);
          try {
            const res = await endpoints.deleteHandover(h.id);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setDone({ message: `Handover deleted · ${name} now holds ${inr(Math.max(0, res.balance))}` });
            await load();
          } catch (e) {
            setActionError(errorMessage(e));
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        },
      },
    ]);
  };

  const days = row ? [...row.days].reverse() : [];

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
      <Stack.Screen options={{ title: name }} />
      {!row && error ? <ErrorState message={error} onRetry={load} /> : null}
      {!row && !error ? (
        <View style={{ height: 240 }}>
          <Loading />
        </View>
      ) : null}

      {row ? (
        <>
          <Card style={{ gap: space.sm }}>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}>
                <AppText variant="small">Cash to receive now</AppText>
                <AppText variant="priceLg" color={balance > 0 ? t.warning : t.success}>
                  {inr(balance)}
                </AppText>
                {avail ? (
                  <View style={{ gap: 2, marginBottom: 4 }}>
                    <PartnerBadge a={avail} />
                    <AppText variant="small">
                      {avail.active} of {avail.max} orders{avail.reason && !avail.available ? ` · ${avail.reason}` : ""}
                    </AppText>
                  </View>
                ) : null}
                <AppText variant="small">
                  {row.agent.name} · +91 {row.agent.phone}
                  {row.agent.status !== "ACTIVE" ? " · inactive" : ""}
                </AppText>
              </View>
              <Pressable
                onPress={() => void Linking.openURL(`tel:${row.agent.phone}`)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${row.agent.name}`}
                style={[styles.call, { borderColor: t.border }]}
              >
                <Ionicons name="call" size={22} color={t.primary} />
              </Pressable>
            </Row>
            {avail ? <MarkBackButton a={avail} onDone={() => void availability.load()} /> : null}
            <Button
              title="Record cash received"
              icon="cash-outline"
              variant={balance > 0 ? "success" : "secondary"}
              size="lg"
              onPress={() => {
                setDone(null);
                setRecording({ agent, balance });
              }}
            />
          </Card>
          {error ? <Notice kind="warning" message={`Couldn't refresh: ${error}`} /> : null}
          {actionError ? <Notice kind="error" message={actionError} /> : null}
          {done ? <Notice kind="success" message={done.message} /> : null}
          {done?.warnings?.map((w) => <Notice key={w} kind="warning" message={w} />)}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {ACTIVITY_PERIODS.map((p) => (
              <Chip
                key={p.value}
                label={p.label}
                selected={period === p.value}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setPeriod(p.value);
                }}
              />
            ))}
          </ScrollView>

          <Card style={{ gap: space.sm }}>
            <Row style={{ justifyContent: "space-between" }}>
              <Total label="Collected" value={inr(row.totals.cashCollected)} />
              <Total label="Received" value={inr(row.totals.cashReceived)} />
              <Total label="To receive" value={inr(row.totals.closingBalance)} strong />
            </Row>
            <AppText variant="small">
              Opening {inr(row.totals.openingBalance)} · {row.totals.delivered} delivered
              {row.totals.cancelled ? ` · ${row.totals.cancelled} cancelled` : ""} · {formatMinutes(row.totals.onDutyMinutes)} on duty
            </AppText>
          </Card>

          <AppText variant="h3">Day by day</AppText>
          {days.map((d) => (
            <DayRow key={d.date} d={d} onPress={() => setTimeline(d.date)} />
          ))}

          <AppText variant="h3">Handovers</AppText>
          {handovers && handovers.length === 0 ? <AppText variant="muted">No cash received in this period.</AppText> : null}
          {handovers?.map((h) => (
            <Card key={h.id} style={{ gap: space.sm, paddingVertical: space.md }}>
              <Row style={{ justifyContent: "space-between" }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <AppText style={{ fontWeight: "800" }}>
                    {formatDate(h.receivedAt)} · {formatTime(h.receivedAt)}
                  </AppText>
                  <AppText variant="small">
                    Received by {h.receivedBy?.name ?? "—"}
                    {h.note ? ` · ${h.note}` : ""}
                  </AppText>
                </View>
                <AppText variant="price" color={t.success}>
                  {inr(h.amount)}
                </AppText>
              </Row>
              <Row>
                <Button
                  title="Edit"
                  icon="create-outline"
                  variant="secondary"
                  size="md"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setDone(null);
                    setRecording({ agent, balance, handover: h });
                  }}
                />
                <Button title="Delete" icon="trash-outline" variant="ghost" size="md" style={{ flex: 1 }} onPress={() => remove(h)} />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <RecordHandoverSheet
        target={recording}
        onClose={() => setRecording(null)}
        onSaved={(message, warnings) => {
          setRecording(null);
          setDone({ message, warnings });
          void load();
        }}
      />
      <TimelineSheet target={timeline ? { agentId, name, date: timeline } : null} onClose={() => setTimeline(null)} />
    </Screen>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <AppText variant="small">{label}</AppText>
      <AppText style={{ fontWeight: strong ? "900" : "800", fontSize: font.lg }} color={strong ? t.warning : undefined}>
        {value}
      </AppText>
    </View>
  );
}

function DayRow({ d, onPress }: { d: PartnerActivityDay; onPress: () => void }) {
  const t = useTheme();
  const duty = d.clockIn ? `${formatTime(d.clockIn)} – ${d.clockOut ? formatTime(d.clockOut) : "on duty"}` : "Not clocked in";
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${dayTitle(d.date)}. ${d.delivered} delivered. ${inr(d.closingBalance)} to receive. Open timeline`}
      style={({ pressed }) => [styles.day, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.border }]}
    >
      <Row style={{ justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <AppText style={{ fontWeight: "800" }}>{dayTitle(d.date)}</AppText>
          <AppText variant="small">
            {duty} · {d.delivered} delivered{d.codDelivered ? ` (${d.codDelivered} COD)` : ""}
            {d.issues ? ` · ${d.issues} issue${d.issues === 1 ? "" : "s"}` : ""}
          </AppText>
        </View>
        <Ionicons name="chevron-forward" size={20} color={t.textMuted} />
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <Cell label="Collected" value={inr(d.cashCollected)} />
        <Cell label="Received" value={inr(d.cashReceived)} />
        <Cell label="To receive" value={inr(d.closingBalance)} color={d.closingBalance > 0 ? t.warning : t.success} />
      </Row>
    </Pressable>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <AppText variant="small">{label}</AppText>
      <AppText style={{ fontWeight: "800" }} color={color}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  call: { width: TAP, height: TAP, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  day: { borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: space.sm, minHeight: TAP + 24 },
});

export default withAccess(["delivery:manage"], PartnerDetail);
