import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ROLE_LABELS } from "@canavo/shared";
import { useClock } from "../../src/attendance/useClock";
import { isDeliveryPartner } from "../../src/auth/access";
import { DeliveryHome } from "../../src/delivery/DeliveryHome";
import { useSignedIn } from "../../src/auth/AuthContext";
import { BusinessBrandRow } from "../../src/components/BusinessBrand";
import { PinPad } from "../../src/components/PinPad";
import { SelfieCapture } from "../../src/attendance/SelfieCapture";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Notice, Row } from "../../src/components/ui";
import { endpoints } from "../../src/lib/api";
import { formatDuration, formatMinutes, formatTime } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { LowStockAlerts, OwnerSummary } from "../../src/lib/types";
import { OwnerSummaryView } from "../../src/reports/OwnerSummaryView";
import { useNotifications } from "../../src/notifications/NotificationsContext";
import { brand, font, space, useTheme } from "../../src/theme";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function accuracyLabel(acc: number | null) {
  if (acc == null) return { text: "GPS accuracy unknown", tone: "warning" as const };
  if (acc <= 30) return { text: `GPS ±${acc} m · good`, tone: "success" as const };
  if (acc <= 100) return { text: `GPS ±${acc} m · fair`, tone: "warning" as const };
  return { text: `GPS ±${acc} m · weak — move to an open area`, tone: "danger" as const };
}

/** Delivery partners get their own Home (duty, cash in hand, collections). */
export default function Home() {
  const { access, outlet } = useSignedIn();
  return outlet && isDeliveryPartner(access) && !access.permissions.includes("order:create") ? <DeliveryHome /> : <StaffHome />;
}

function StaffHome() {
  const { me, outlet, allowed, stale } = useSignedIn();
  const businessName = me.business?.name ?? outlet?.businessName ?? null;
  const t = useTheme();
  const canClock = allowed("attendance:self");
  const c = useClock(outlet?.id ?? null, canClock);
  const clockedIn = !!c.status?.clockedIn;
  const now = useNow(clockedIn);
  const [report, setReport] = useState<OwnerSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const canReport = allowed("report:view");
  const canStock = allowed("inventory:view");
  const { unread } = useNotifications();
  const [lowStock, setLowStock] = useState<LowStockAlerts | null>(null);

  const loadLowStock = useCallback(async () => {
    if (!canStock) return;
    try {
      setLowStock(await endpoints.inventoryAlerts());
    } catch {
      setLowStock(null);
    }
  }, [canStock]);

  useEffect(() => {
    void loadLowStock();
  }, [loadLowStock, outlet?.id]);
  useSocketEvent("inventory:low", () => void loadLowStock());

  const loadReport = useCallback(async () => {
    if (!canReport) return;
    try {
      setReport(await endpoints.ownerSummary());
    } catch {
      setReport(null);
    }
  }, [canReport]);

  useEffect(() => {
    void loadReport();
  }, [loadReport, outlet?.id]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([c.reload(), loadReport(), loadLowStock()]);
    setRefreshing(false);
  };

  const busy = c.phase !== "idle";
  const phaseLabel =
    c.phase === "locating" ? "Getting location…" : c.phase === "verifying" ? "Confirm it's you…" : "Submitting…";
  const since = c.status?.current ? new Date(c.status.current.clockInAt).getTime() : null;
  const acc = c.fix ? accuracyLabel(c.fix.accuracy) : null;
  const accColor = acc ? { success: t.success, warning: t.warning, danger: t.danger }[acc.tone] : t.textMuted;

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Row style={{ alignItems: "flex-start" }}>
        <View style={{ gap: 2, flex: 1 }}>
          <AppText variant="muted">{greeting()},</AppText>
          <AppText variant="title">{me.name.split(" ")[0]}</AppText>
          {/* Hotel logo + name (initials when there's no logo); platform admins keep CANAVO. */}
          <BusinessBrandRow />
          <AppText variant="small">
            {me.platformAdmin ? "Platform admin" : ROLE_LABELS[me.role]}
            {outlet ? ` · ${outlet.name}` : ""}
          </AppText>
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
      {canStock && lowStock && lowStock.count > 0 ? (
        <Pressable onPress={() => router.push(allowed("order:create") ? "/inventory" : "/(tabs)/stock")} accessibilityRole="button">
          <Notice
            kind="warning"
            title={`${lowStock.count} item${lowStock.count === 1 ? "" : "s"} low on stock`}
            message={`${lowStock.items.slice(0, 3).map((i) => i.name).join(", ")}${lowStock.count > 3 ? "…" : ""} · tap to view`}
          />
        </Pressable>
      ) : null}

      {canClock ? (
        <>
          <Card style={{ alignItems: "center", gap: space.md, paddingVertical: space.xl }}>
            <Row>
              <Ionicons name="time-outline" size={18} color={t.textMuted} />
              <AppText variant="muted">
                {me.shift
                  ? `${me.shift.name} shift · ${me.shift.startTime}–${me.shift.endTime} (grace ${me.shift.graceMinutes} min)`
                  : "No shift assigned"}
              </AppText>
            </Row>

            {c.loadingStatus ? (
              <ActivityIndicator color={t.primary} size="large" style={{ height: 220 }} />
            ) : (
              <Pressable
                onPress={c.clock}
                disabled={busy || !!c.statusError}
                accessibilityRole="button"
                accessibilityLabel={clockedIn ? "Clock out" : "Clock in"}
                style={({ pressed }) => [
                  styles.clockButton,
                  {
                    backgroundColor: clockedIn ? brand.saffron : brand.forest,
                    opacity: busy ? 0.7 : 1,
                    transform: [{ scale: pressed ? 0.97 : 1 }],
                  },
                ]}
              >
                {busy ? (
                  <>
                    <ActivityIndicator color="#fff" size="large" />
                    <AppText style={styles.clockSub}>{phaseLabel}</AppText>
                  </>
                ) : (
                  <>
                    <Ionicons name={clockedIn ? "log-out-outline" : "finger-print"} size={44} color="#fff" />
                    <AppText style={styles.clockText}>{clockedIn ? "CLOCK OUT" : "CLOCK IN"}</AppText>
                    {clockedIn && since ? <AppText style={styles.timer}>{formatDuration(now - since)}</AppText> : null}
                  </>
                )}
              </Pressable>
            )}

            {clockedIn && c.status?.current ? (
              <AppText variant="muted" style={{ textAlign: "center" }}>
                On duty since {formatTime(c.status.current.clockInAt)} at {c.status.current.outlet.name}
                {c.status.current.lateByMinutes > 0 ? ` · ${c.status.current.lateByMinutes} min late` : ""}
              </AppText>
            ) : !c.loadingStatus ? (
              <AppText variant="muted">You are off duty</AppText>
            ) : null}

            {acc ? (
              <Row>
                <Ionicons name="locate" size={16} color={accColor} />
                <AppText variant="small" color={accColor} style={{ fontWeight: "700" }}>
                  {acc.text}
                </AppText>
              </Row>
            ) : null}
          </Card>

          {c.statusError ? <Notice kind="error" message={c.statusError} /> : null}
          {c.lastAction ? <Notice kind="success" message={`${c.lastAction} successfully.`} /> : null}
          {c.error ? (
            <View style={{ gap: space.sm }}>
              <Notice
                kind={c.error.kind === "conflict" ? "warning" : "error"}
                title={c.error.title}
                message={
                  c.error.kind === "geofence" && c.fix?.accuracy != null && c.fix.accuracy > 50
                    ? `${c.error.message} Your GPS is only accurate to ±${c.fix.accuracy} m — try again in the open.`
                    : c.error.message
                }
              />
              {c.error.kind === "permission" ? (
                <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => Linking.openSettings()} />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}

      {canReport && report ? (
        <View style={{ gap: space.sm }}>
          <OwnerSummaryView s={report} />
          <Button title="Open reports" variant="secondary" icon="stats-chart" onPress={() => router.push("/(tabs)/reports")} />
        </View>
      ) : null}

      {canClock && c.status?.recent.length ? (
        <Card style={{ gap: space.sm }}>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText variant="h3">Recent attendance</AppText>
            <Pressable onPress={() => router.push("/attendance")} hitSlop={12} style={{ minHeight: 44, justifyContent: "center" }}>
              <AppText color={t.primary} style={{ fontWeight: "700" }}>
                See all
              </AppText>
            </Pressable>
          </Row>
          {c.status.recent.slice(0, 3).map((r) => (
            <Row key={r.id} style={{ justifyContent: "space-between", minHeight: 36 }}>
              <AppText>{r.workDate}</AppText>
              <AppText variant="muted">
                {formatTime(r.clockInAt)} – {r.clockOutAt ? formatTime(r.clockOutAt) : "now"}
                {r.workedMinutes != null ? ` · ${formatMinutes(r.workedMinutes)}` : ""}
              </AppText>
            </Row>
          ))}
        </Card>
      ) : null}

      {canClock ? (
        <Button title="Attendance & leave" variant="secondary" icon="calendar-outline" onPress={() => router.push("/attendance")} />
      ) : null}
      {!canClock && !canReport && !canStock ? (
        <Card style={{ gap: space.sm }}>
          <AppText variant="h3">Welcome to {!me.platformAdmin && businessName ? businessName : "CANAVO"}</AppText>
          <AppText variant="muted">
            {"Use the tabs below to get started. Features your business hasn't enabled are hidden."}
          </AppText>
        </Card>
      ) : null}

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
  clockButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  clockText: { color: "#fff", fontSize: font.xl + 4, fontWeight: "900", letterSpacing: 1 },
  clockSub: { color: "#fff", fontSize: font.md, fontWeight: "700" },
  timer: { color: "#fff", fontSize: font.xl, fontWeight: "800", fontVariant: ["tabular-nums"] },
  bell: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  bellBadge: { position: "absolute", top: 4, right: 2, minWidth: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
});
