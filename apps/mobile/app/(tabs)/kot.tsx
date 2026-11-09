import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Vibration, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { AppText, Chip, EmptyState, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatDuration, formatTime, humanize } from "../../src/lib/format";
import { useSocketConnected, useSocketEvent, useSocketReconnect } from "../../src/lib/socket";
import type { Kot, KotStatus } from "../../src/lib/types";
import { playAlertSound } from "../../src/notifications/push";
import { printKot } from "../../src/printing";
import { font, radius, space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

const NEXT: Partial<Record<KotStatus, { status: KotStatus; label: string }>> = {
  RECEIVED: { status: "PREPARING", label: "Start cooking" },
  PREPARING: { status: "READY", label: "Mark ready" },
  READY: { status: "SERVED", label: "Served" },
};

/** Fallback poll: the socket can miss events (flaky Wi-Fi, app in background). */
const POLL_MS = 15_000;
const ALERT_VIBRATION = [0, 400, 200, 400];

function KotScreen() {
  const t = useTheme();
  const { allowed, outlet } = useSignedIn();
  const canUpdate = allowed("kot:update");
  const [kots, setKots] = useState<Kot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [station, setStation] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const live = useSocketConnected();
  const [printing, setPrinting] = useState<string | null>(null);
  /** Ticket ids already shown (and alerted); null until the first load of this outlet sets the baseline. */
  const seen = useRef<Set<string> | null>(null);

  /** Alert once per ticket id, however it was discovered (socket, reload, poll). */
  const markSeen = useCallback((ids: string[], fromLoad: boolean) => {
    const set = seen.current;
    let fresh = ids;
    if (!set) {
      // First load is the baseline (no alert); a socket ticket before it still buzzes.
      if (fromLoad) {
        seen.current = new Set(ids);
        return;
      }
    } else {
      fresh = ids.filter((id) => !set.has(id));
      fresh.forEach((id) => set.add(id));
      if (fromLoad && set.size > 1000) seen.current = new Set(ids);
    }
    if (!fresh.length) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Vibration.vibrate(ALERT_VIBRATION);
    // A live `kot:new` also brings a `kot.new` notification, which rings; tickets found by reload/poll ring here.
    if (fromLoad) {
      const n = fresh.length;
      void playAlertSound("kot.new", n === 1 ? "New kitchen order" : `${n} new kitchen orders`, "Open the kitchen screen");
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await endpoints.kots();
      setKots(list);
      setError(null);
      markSeen(
        list.map((k) => k.id),
        true,
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [markSeen]);

  useEffect(() => {
    setKots(null);
    seen.current = null;
    void load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Back from the background: events sent meanwhile were missed.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void load();
    });
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      sub.remove();
    };
  }, [load, outlet?.id]);

  // (Re)connected: anything emitted while the socket was down was lost.
  useSocketReconnect(() => {
    void load();
  });
  useSocketEvent("kot:new", (fresh) => {
    const ids = (Array.isArray(fresh) ? fresh : []).map((k) => (k as { id?: string } | null)?.id).filter((id): id is string => !!id);
    if (ids.length) markSeen(ids, false);
    else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    void load();
  });
  useSocketEvent("kot:updated", () => {
    void load();
  });
  // Waiter voided a running-tab item: strike it through right away, then sync.
  useSocketEvent("kot:void", (p) => {
    setKots((cur) =>
      cur
        ? cur.map((k) =>
            k.id === p.kotId ? { ...k, items: k.items.map((it) => (it.sessionItemId === p.sessionItemId ? { ...it, voided: true } : it)) } : k,
          )
        : cur,
    );
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    void load();
  });

  const print = async (kot: Kot) => {
    setPrinting(kot.id);
    setActionError(null);
    try {
      await printKot(kot);
    } catch (e) {
      setActionError(errorMessage(e, "Could not print the ticket"));
    } finally {
      setPrinting(null);
    }
  };

  const advance = async (kot: Kot) => {
    const next = NEXT[kot.status];
    if (!next || !canUpdate) return;
    setUpdating(kot.id);
    setActionError(null);
    // Optimistic: served tickets leave the board immediately.
    setKots((cur) =>
      cur
        ? next.status === "SERVED"
          ? cur.filter((k) => k.id !== kot.id)
          : cur.map((k) => (k.id === kot.id ? { ...k, status: next.status } : k))
        : cur,
    );
    try {
      await endpoints.updateKot(kot.id, next.status);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      setActionError(errorMessage(e));
      void load();
    } finally {
      setUpdating(null);
    }
  };

  const stations = useMemo(() => [...new Set((kots ?? []).map((k) => k.station))].sort(), [kots]);
  const visible = useMemo(() => (kots ?? []).filter((k) => !station || k.station === station), [kots, station]);

  const statusColor = (s: KotStatus) =>
    s === "RECEIVED" ? t.info : s === "PREPARING" ? t.warning : s === "READY" ? t.success : t.textMuted;

  if (!kots && error) return <Screen scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!kots) return <Screen scroll={false}><Loading label="Loading kitchen orders…" /></Screen>;

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Row style={{ gap: space.sm }}>
            <AppText variant="h2">Kitchen</AppText>
            <View
              accessible
              accessibilityLabel={live ? "Live updates on" : "Reconnecting to live updates"}
              style={[styles.live, { backgroundColor: live ? t.successBg : t.warningBg }]}
            >
              <View style={[styles.liveDot, { backgroundColor: live ? t.success : t.warning }]} />
              <AppText style={{ fontSize: font.sm, fontWeight: "800" }} color={live ? t.success : t.warning}>
                {live ? "Live" : "Reconnecting…"}
              </AppText>
            </View>
          </Row>
          <AppText variant="muted">{visible.length} active</AppText>
        </Row>
        {stations.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            <Chip label="All stations" selected={!station} onPress={() => setStation(null)} />
            {stations.map((s) => (
              <Chip key={s} label={humanize(s)} selected={station === s} onPress={() => setStation(s)} />
            ))}
          </ScrollView>
        ) : null}
        {error ? <Notice kind="warning" message={`Live refresh failed: ${error}`} /> : null}
        {actionError ? <Notice kind="error" message={actionError} /> : null}
      </View>
      <FlatList
        data={visible}
        keyExtractor={(k) => k.id}
        contentContainerStyle={{ padding: space.md, gap: space.md, paddingBottom: space.xl * 2 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            colors={[t.primary]}
            tintColor={t.primary}
          />
        }
        ListEmptyComponent={<EmptyState icon="restaurant-outline" title="All caught up" message="New orders appear here instantly." />}
        renderItem={({ item: k }) => {
          const ageMs = now - new Date(k.createdAt).getTime();
          const ageMin = ageMs / 60_000;
          const timerColor = ageMin >= 20 ? t.danger : ageMin >= 10 ? t.warning : t.success;
          const next = NEXT[k.status];
          const isPreOrder = k.order?.orderType === "PRE_ORDER" || !!k.order?.scheduledFor;
          const tableLabel = k.session?.tableLabel ?? k.order?.tableLabel ?? null;
          const typeLabel = k.session ? "Running tab" : humanize(k.order?.orderType ?? "");
          return (
            <Pressable
              onPress={() => advance(k)}
              disabled={!canUpdate || !next || updating === k.id}
              accessibilityRole="button"
              accessibilityLabel={`KOT ${k.kotNumber}, ${humanize(k.status)}${next && canUpdate ? `. Tap to ${next.label}` : ""}`}
              style={({ pressed }) => [
                styles.card,
                { backgroundColor: t.surface, borderColor: statusColor(k.status), opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Row style={{ justifyContent: "space-between" }}>
                <AppText variant="h2">KOT #{k.kotNumber}</AppText>
                <Row style={{ gap: 4 }}>
                  <Ionicons name="timer-outline" size={20} color={timerColor} />
                  <AppText style={{ color: timerColor, fontWeight: "900", fontSize: font.lg, fontVariant: ["tabular-nums"] }}>
                    {formatDuration(ageMs).replace(/^00:/, "")}
                  </AppText>
                </Row>
              </Row>
              {tableLabel || isPreOrder ? (
                <Row style={{ flexWrap: "wrap" }}>
                  {tableLabel ? (
                    <View style={[styles.tag, { backgroundColor: t.primary }]}>
                      <Ionicons name="grid" size={14} color={t.primaryText} />
                      <AppText style={[styles.tagText, { color: t.primaryText }]}>Table {tableLabel}</AppText>
                    </View>
                  ) : null}
                  {isPreOrder ? (
                    <View style={[styles.tag, { backgroundColor: t.info }]}>
                      <Ionicons name="calendar" size={14} color="#fff" />
                      <AppText style={styles.tagText}>
                        PRE-ORDER{k.order?.scheduledFor ? ` · ${formatTime(k.order.scheduledFor)}` : ""}
                      </AppText>
                    </View>
                  ) : null}
                </Row>
              ) : null}
              <AppText variant="muted">
                {typeLabel} · {humanize(k.station)}
                {k.order ? ` · ${k.order.invoiceNumber}` : ""}
                {k.order?.customerName ? ` · ${k.order.customerName}` : ""}
              </AppText>
              <View style={{ gap: 4, marginVertical: space.sm }}>
                {k.items.map((it, i) => (
                  <View key={i} style={it.voided ? { opacity: 0.55 } : undefined}>
                    <AppText
                      style={{ fontSize: font.lg, fontWeight: "700", textDecorationLine: it.voided ? "line-through" : "none" }}
                      color={it.voided ? t.danger : undefined}
                    >
                      {it.quantity} × {it.name}
                      {it.voided ? "  VOID" : ""}
                    </AppText>
                    {it.addons?.map((a) => (
                      <AppText key={a} variant="muted" style={{ marginLeft: space.lg }}>
                        + {a}
                      </AppText>
                    ))}
                    {it.notes ? (
                      <AppText color={t.danger} style={{ marginLeft: space.lg, fontWeight: "700" }}>
                        ! {it.notes}
                      </AppText>
                    ) : null}
                  </View>
                ))}
                {k.order?.notes ? <AppText color={t.danger}>Note: {k.order.notes}</AppText> : null}
              </View>
              <Row style={{ justifyContent: "space-between" }}>
                <Row style={{ gap: space.sm }}>
                  <View style={[styles.status, { backgroundColor: statusColor(k.status) }]}>
                    <AppText style={{ color: "#fff", fontWeight: "800" }}>{humanize(k.status)}</AppText>
                  </View>
                  <Pressable
                    onPress={() => print(k)}
                    disabled={printing === k.id}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Print KOT ${k.kotNumber}`}
                    style={[styles.print, { borderColor: t.border, opacity: printing === k.id ? 0.5 : 1 }]}
                  >
                    <Ionicons name="print-outline" size={20} color={t.textMuted} />
                  </Pressable>
                </Row>
                {next && canUpdate ? (
                  <Row style={{ gap: 4 }}>
                    <AppText color={t.primary} style={{ fontWeight: "800", fontSize: font.lg }}>
                      {updating === k.id ? "Updating…" : next.label}
                    </AppText>
                    <Ionicons name="arrow-forward-circle" size={28} color={t.primary} />
                  </Row>
                ) : null}
              </Row>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 2, borderLeftWidth: 8, padding: space.lg, gap: 4 },
  status: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill },
  tag: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  tagText: { color: "#fff", fontWeight: "900", fontSize: font.md },
  live: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  print: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["kot:view"], KotScreen);
