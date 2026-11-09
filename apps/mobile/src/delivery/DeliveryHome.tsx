import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useClock } from "../attendance/useClock";
import { useSignedIn } from "../auth/AuthContext";
import { BusinessBrandRow } from "../components/BusinessBrand";
import { PinPad } from "../components/PinPad";
import { SelfieCapture } from "../attendance/SelfieCapture";
import { Screen } from "../components/Screen";
import { AppText, Button, Card, Loading, Notice, Row, Segmented } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { formatDuration, formatMinutes, formatTime, inr, inrShort } from "../lib/format";
import { useSocketEvent, useSocketReconnect } from "../lib/socket";
import type { DeliverySummary } from "../lib/types";
import { useNotifications } from "../notifications/NotificationsContext";
import { brand, font, radius, space, TAP, useTheme } from "../theme";
import { DayBars } from "./DayBars";
import { PresenceCard, usePartnerPresence } from "./PartnerPresence";
import { PERIODS, fillDays, periodRange, type Period } from "./portal";

function useSecondTick(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Stat({ icon, label, value, color }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; color: string }) {
  const t = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: t.surface, borderColor: t.border }]}>
      <Row style={{ gap: 6 }}>
        <Ionicons name={icon} size={18} color={color} />
        <AppText variant="small">{label}</AppText>
      </Row>
      <AppText variant="price" style={{ fontSize: font.xl }}>
        {value}
      </AppText>
    </View>
  );
}

/** Delivery partner Home: duty (clock in / out), cash in hand → Cash tab, today's (or a period's) deliveries and trend. */
export function DeliveryHome() {
  const t = useTheme();
  const { me, outlet, allowed, stale } = useSignedIn();
  const { unread } = useNotifications();
  const canClock = allowed("attendance:self");
  const c = useClock(outlet?.id ?? null, canClock);
  const clockedIn = !!c.status?.clockedIn;
  const now = useSecondTick(clockedIn);
  const [period, setPeriod] = useState<Period>("today");
  const range = useMemo(() => periodRange(period), [period]);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const presence = usePartnerPresence();
  const reloadPresence = presence?.reload;

  const load = useCallback(async () => {
    try {
      setSummary(await endpoints.myDeliverySummary(range));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load, outlet?.id]);
  useSocketEvent("delivery:updated", () => void load());
  useSocketEvent("notification", () => void load());
  useSocketReconnect(() => void load());

  // Re-read the duty state after clocking in/out.
  useEffect(() => {
    if (c.lastAction) {
      void load();
      void reloadPresence?.();
    }
  }, [c.lastAction, load, reloadPresence]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([c.reload(), load(), presence?.reload()]);
    setRefreshing(false);
  };

  const busy = c.phase !== "idle";
  const phaseLabel = c.phase === "locating" ? "Getting location…" : c.phase === "verifying" ? "Confirm it's you…" : "Submitting…";
  const since = c.status?.current ? new Date(c.status.current.clockInAt).getTime() : null;
  const onDuty = canClock ? clockedIn : !!summary?.onDuty;
  const days = summary && range.from !== range.to ? fillDays(summary.byDay, range) : null;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Row style={{ alignItems: "flex-start" }}>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="muted">Hi,</AppText>
          <AppText variant="title">{me.name.split(" ")[0]}</AppText>
          <BusinessBrandRow />
          <AppText variant="small">Delivery partner{outlet ? ` · ${outlet.name}` : ""}</AppText>
        </View>
        <Pressable
          onPress={() => router.push("/notifications")}
          style={[styles.bell, { backgroundColor: t.surface, borderColor: t.border }]}
          accessibilityRole="button"
          accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Ionicons name="notifications-outline" size={26} color={t.text} />
          {unread ? (
            <View style={[styles.bellBadge, { backgroundColor: t.danger }]}>
              <AppText style={{ color: "#fff", fontSize: 11, fontWeight: "900" }}>{unread > 99 ? "99+" : unread}</AppText>
            </View>
          ) : null}
        </Pressable>
      </Row>
      {stale ? <Notice kind="warning" message="Offline — showing your saved profile." /> : null}

      {/* Duty */}
      <Card style={{ gap: space.md, borderLeftWidth: 6, borderLeftColor: onDuty ? t.success : t.textMuted }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Row>
            <View style={[styles.dot, { backgroundColor: onDuty ? t.success : t.textMuted }]} />
            <AppText variant="h3">{onDuty ? "On duty" : "Off duty"}</AppText>
          </Row>
          {onDuty && since ? (
            <AppText variant="price" style={{ fontSize: font.lg }}>
              {formatDuration(now - since)}
            </AppText>
          ) : null}
        </Row>
        <AppText variant="muted">
          {onDuty && c.status?.current
            ? `Since ${formatTime(c.status.current.clockInAt)} at ${c.status.current.outlet.name}${c.status.current.lateByMinutes > 0 ? ` · ${c.status.current.lateByMinutes} min late` : ""}`
            : onDuty && summary?.onDutySince
              ? `Since ${formatTime(summary.onDutySince)}`
              : "Clock in at the outlet to start your shift."}
        </AppText>
        {canClock ? (
          <Button
            title={busy ? phaseLabel : clockedIn ? "Clock out" : "Clock in · Go on duty"}
            icon={clockedIn ? "log-out-outline" : "finger-print"}
            variant={clockedIn ? "secondary" : "success"}
            size="xl"
            loading={busy && c.phase === "submitting"}
            disabled={busy || c.loadingStatus || !!c.statusError}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              void c.clock();
            }}
          />
        ) : null}
        {canClock && clockedIn ? <AppText variant="small">You can clock out from anywhere when your shift ends.</AppText> : null}
        {c.statusError ? <Notice kind="error" message={c.statusError} /> : null}
        {c.lastAction ? <Notice kind="success" message={`${c.lastAction} successfully.`} /> : null}
        {c.error ? (
          <>
            <Notice kind={c.error.kind === "conflict" ? "warning" : "error"} title={c.error.title} message={c.error.message} />
            {c.error.kind === "permission" ? <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => Linking.openSettings()} /> : null}
          </>
        ) : null}
      </Card>

      {/* Dispatch: at the outlet / on a run / returning (GPS while clocked in) */}
      <PresenceCard />

      {error && !summary ? <Notice kind="error" message={error} /> : null}
      {error && summary ? <Notice kind="warning" message={`Couldn't refresh: ${error}`} /> : null}
      {!summary && !error ? (
        <View style={{ height: 160 }}>
          <Loading />
        </View>
      ) : null}

      {summary ? (
        <>
          {/* Cash in hand: what to hand over at the outlet (independent of the period) → Cash tab */}
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.navigate("/(tabs)/cash");
            }}
            accessibilityRole="button"
            accessibilityLabel={`Cash in hand ${inr(summary.cashInHand)}. Open cash to hand over`}
            style={({ pressed }) => [styles.cash, { backgroundColor: summary.cashInHand > 0 ? brand.saffron : t.successBg, opacity: pressed ? 0.85 : 1 }]}
          >
            <Row style={{ justifyContent: "space-between" }}>
              <Row style={{ gap: space.sm }}>
                <Ionicons name="wallet" size={24} color={summary.cashInHand > 0 ? "#fff" : t.success} />
                <AppText style={{ fontWeight: "800", fontSize: font.lg, color: summary.cashInHand > 0 ? "#fff" : t.success }}>Cash in hand</AppText>
              </Row>
              <Ionicons name="chevron-forward" size={24} color={summary.cashInHand > 0 ? "#fff" : t.success} />
            </Row>
            <AppText variant="priceLg" style={{ color: summary.cashInHand > 0 ? "#fff" : t.success }}>
              {inr(Math.max(0, summary.cashInHand))}
            </AppText>
            <AppText style={{ color: summary.cashInHand > 0 ? "#fff" : t.success, fontWeight: "600" }}>
              {summary.cashInHand > 0
                ? `Hand over to the cashier/manager · ${summary.cashInHandOrders} order${summary.cashInHandOrders === 1 ? "" : "s"} · tap for details`
                : "Nothing to hand over. All settled."}
            </AppText>
          </Pressable>

          {/* Cash on Delivery still to collect on active orders */}
          {summary.codOrders ? (
            <Pressable
              onPress={() => router.navigate("/(tabs)/deliveries")}
              accessibilityRole="button"
              accessibilityLabel={`COD to collect ${inr(summary.codToCollect ?? 0)} on ${summary.codOrders} orders. Open deliveries`}
              style={({ pressed }) => [styles.cod, { backgroundColor: pressed ? t.surfaceAlt : t.warningBg, borderColor: t.warning }]}
            >
              <Ionicons name="cash" size={30} color={t.warning} />
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontWeight: "800", fontSize: font.lg }} color={t.warning}>
                  COD to collect
                </AppText>
                <AppText variant="price" style={{ fontSize: font.xl }} color={t.warning}>
                  {inr(summary.codToCollect ?? 0)}
                </AppText>
                <AppText variant="small" color={t.warning}>
                  Cash at the door · {summary.codOrders} order{summary.codOrders === 1 ? "" : "s"}
                </AppText>
              </View>
              <Ionicons name="chevron-forward" size={24} color={t.warning} />
            </Pressable>
          ) : null}

          {/* Active */}
          <Pressable
            onPress={() => router.navigate("/(tabs)/deliveries")}
            accessibilityRole="button"
            accessibilityLabel={`${summary.activeDeliveries} active deliveries. Open deliveries`}
            style={({ pressed }) => [styles.active, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: summary.activeDeliveries ? t.primary : t.border }]}
          >
            <View style={[styles.activeCount, { backgroundColor: summary.activeDeliveries ? t.primary : t.surfaceAlt }]}>
              <AppText style={{ color: summary.activeDeliveries ? t.primaryText : t.textMuted, fontWeight: "900", fontSize: font.xl }}>{summary.activeDeliveries}</AppText>
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="h3">Active deliver{summary.activeDeliveries === 1 ? "y" : "ies"}</AppText>
              <AppText variant="small">{summary.activeDeliveries ? "Tap to open your deliveries" : "New assignments arrive as a notification"}</AppText>
            </View>
            <Ionicons name="chevron-forward" size={24} color={t.textMuted} />
          </Pressable>

          {/* Period summary */}
          <Segmented options={PERIODS} value={period} onChange={(p) => { void Haptics.selectionAsync(); setPeriod(p); }} />
          <Card style={{ gap: space.md }}>
            <Row style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
              <View>
                <AppText variant="small">Deliveries done</AppText>
                <AppText variant="priceLg">{summary.delivered}</AppText>
              </View>
              {summary.cancelled ? <AppText variant="small">{summary.cancelled} cancelled</AppText> : null}
            </Row>
            <View style={styles.grid}>
              <Stat icon="cash-outline" label="Cash collected" value={inrShort(summary.collected.cash)} color={t.warning} />
              <Stat icon="checkmark-circle-outline" label="Already paid" value={inrShort(summary.collected.prepaid)} color={t.success} />
            </View>
            <Row style={{ justifyContent: "space-around" }}>
              <View style={{ alignItems: "center" }}>
                <AppText variant="small">Avg delivery time</AppText>
                <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{summary.avgDeliveryMinutes != null ? formatMinutes(summary.avgDeliveryMinutes) : "—"}</AppText>
              </View>
              <View style={{ alignItems: "center" }}>
                <AppText variant="small">Distance</AppText>
                <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{summary.distanceKm} km</AppText>
              </View>
              {summary.deliveryFees ? (
                <View style={{ alignItems: "center" }}>
                  <AppText variant="small">Delivery fees</AppText>
                  <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{inrShort(summary.deliveryFees)}</AppText>
                </View>
              ) : null}
            </Row>
            {days ? (
              <View style={{ gap: space.xs }}>
                <AppText variant="h3">Deliveries per day</AppText>
                <DayBars days={days} />
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      {canClock ? <Button title="Attendance & leave" variant="secondary" icon="calendar-outline" onPress={() => router.push("/attendance")} /> : null}

      <PinPad
        visible={c.pinRequired}
        title={clockedIn ? "PIN to clock out" : "PIN to clock in"}
        error={c.pinError}
        busy={c.phase === "submitting" || c.phase === "locating"}
        onSubmit={c.submitPin}
        onClose={c.cancelPin}
      />
      <SelfieCapture visible={c.selfieRequired} busy={c.phase === "submitting" || c.phase === "locating"} onCapture={(uri) => void c.submitSelfie(uri)} onCancel={c.cancelSelfie} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bell: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  bellBadge: { position: "absolute", top: 4, right: 2, minWidth: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  dot: { width: 14, height: 14, borderRadius: 7 },
  cash: { borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  cod: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 2, borderRadius: radius.lg, padding: space.md, minHeight: TAP + 16 },
  active: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.lg, padding: space.md, minHeight: TAP + 16 },
  activeCount: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  stat: { flexGrow: 1, flexBasis: "45%", borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: 4 },
});
