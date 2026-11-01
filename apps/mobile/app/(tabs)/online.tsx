import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, RefreshControl, ScrollView, StyleSheet, Vibration, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { canViewOnlineOrders } from "../../src/auth/access";
import { BOARD_SECTIONS, countByStage, ordersInStage } from "../../src/channels/board";
import { NEW_ORDER_VIBRATION, useChannels } from "../../src/channels/ChannelsContext";
import { BoardOrderCard, HandoverSheet, RejectSheet, RequestCard } from "../../src/channels/OnlineOrders";
import { Screen } from "../../src/components/Screen";
import { AppText, Chip, EmptyState, ErrorState, FeatureOff, Loading, Notice, Row } from "../../src/components/ui";
import { ApiError, endpoints, errorMessage } from "../../src/lib/api";
import { useSocketConnected, useSocketEvent, useSocketReconnect } from "../../src/lib/socket";
import type { ChannelBoardOrder, ChannelBoardStage, ChannelRequest } from "../../src/lib/types";
import { playAlertSound } from "../../src/notifications/push";
import { font, radius, space, useTheme } from "../../src/theme";

/** Fallback poll: the socket can miss events (flaky Wi-Fi, app in background). */
const POLL_MS = 20_000;

/**
 * Phase 6 "Online orders": the queue of QR / online orders waiting for staff to accept
 * (anyone who can serve tables or bill), then the board of online + aggregator orders
 * (Zomato, Swiggy, ONDC, own page) from New → Preparing → Packed → Handed over.
 */
function OnlineOrdersScreen() {
  const t = useTheme();
  const { access, outlet } = useSignedIn();
  const channels = useChannels();
  const { canBoard, canHandle, requests, markOff } = channels;
  const live = useSocketConnected();

  const [orders, setOrders] = useState<ChannelBoardOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stage, setStage] = useState<Exclude<ChannelBoardStage, "CANCELLED">>("NEW");
  const [busy, setBusy] = useState<string | null>(null);
  const [handover, setHandover] = useState<ChannelBoardOrder | null>(null);
  const [rejecting, setRejecting] = useState<ChannelRequest | null>(null);
  const [now, setNow] = useState(Date.now());
  /** New-stage order ids already alerted; null until the first load sets the baseline. */
  const seen = useRef<Set<string> | null>(null);

  const alertNew = useCallback((list: ChannelBoardOrder[]) => {
    const ids = list.filter((o) => o.stage === "NEW").map((o) => o.orderId);
    const set = seen.current;
    if (!set) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !set.has(id));
    fresh.forEach((id) => set.add(id));
    if (!fresh.length) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Vibration.vibrate(NEW_ORDER_VIBRATION);
    void playAlertSound("channel.order", fresh.length === 1 ? "New online order" : `${fresh.length} new online orders`, "Open Online orders");
  }, []);

  const loadBoard = useCallback(async () => {
    if (!canBoard) return;
    try {
      const board = await endpoints.channelBoard();
      setOrders(board.orders);
      setError(null);
      alertNew(board.orders);
    } catch (e) {
      if (e instanceof ApiError && e.isModuleDisabled) markOff();
      setError(errorMessage(e));
    }
  }, [canBoard, alertNew, markOff]);

  /** Socket bursts (one order → several events) collapse into one reload. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void loadBoard();
    }, 300);
  }, [loadBoard]);

  useEffect(() => {
    setOrders(null);
    seen.current = null;
    void loadBoard();
    const poll = setInterval(loadBoard, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void loadBoard();
    });
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      sub.remove();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loadBoard, outlet?.id]);

  useSocketReconnect(reloadSoon);
  useSocketEvent("channel:board", (p) => {
    // Move the card right away; the reload brings rider / timestamps.
    if (p?.orderId && p.stage) setOrders((cur) => cur?.map((o) => (o.orderId === p.orderId ? { ...o, stage: p.stage as ChannelBoardStage } : o)) ?? cur);
    reloadSoon();
  });
  useSocketEvent("order:created", reloadSoon);
  useSocketEvent("order:paid", reloadSoon);
  useSocketEvent("order:cancelled", reloadSoon);
  useSocketEvent("kot:updated", reloadSoon);
  useSocketEvent("channel:request", reloadSoon);

  const replace = (updated: ChannelBoardOrder) =>
    setOrders((cur) => cur?.map((o) => (o.orderId === updated.orderId ? updated : o)) ?? cur);

  const packed = async (o: ChannelBoardOrder) => {
    setBusy(o.orderId);
    setActionError(null);
    try {
      replace(await endpoints.channelPacked(o.orderId));
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      setActionError(errorMessage(e));
      void loadBoard();
    } finally {
      setBusy(null);
    }
  };

  const handedOver = async (o: ChannelBoardOrder, riderName?: string) => {
    try {
      replace(await endpoints.channelHandover(o.orderId, riderName));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      void loadBoard();
      throw e;
    }
  };

  const accept = async (r: ChannelRequest) => {
    setBusy(r.id);
    setActionError(null);
    try {
      await channels.accept(r.id);
      reloadSoon();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadBoard(), channels.reload()]);
    setRefreshing(false);
  };

  const counts = useMemo(() => countByStage(orders ?? []), [orders]);
  const visible = useMemo(() => ordersInStage(orders ?? [], stage), [orders, stage]);

  if (!canViewOnlineOrders(access) || channels.off) {
    return (
      <Screen scroll={false}>
        <FeatureOff message="Online orders (QR, own website, Zomato, Swiggy, ONDC) need the Sales channels module. Ask your business owner to turn it on." />
      </Screen>
    );
  }
  if (canBoard && !orders && error) return <Screen scroll={false}><ErrorState message={error} onRetry={loadBoard} /></Screen>;
  if ((canBoard && !orders) || (!canBoard && canHandle && !requests && !channels.requestsError)) {
    return <Screen scroll={false}><Loading label="Loading online orders…" /></Screen>;
  }

  const waiting = requests ?? [];

  const header = (
    <View style={{ gap: space.md }}>
      {canHandle && waiting.length ? (
        <View style={{ gap: space.md }}>
          <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: t.warningBg, borderColor: t.warning }]}>
            <Ionicons name="hourglass-outline" size={24} color={t.warning} />
            <View style={{ flex: 1 }}>
              <AppText style={{ fontWeight: "900", fontSize: font.lg }} color={t.warning}>
                Waiting for you · {waiting.length}
              </AppText>
              <AppText variant="small" color={t.warning}>
                Accept to send to the kitchen, or reject with a reason.
              </AppText>
            </View>
          </View>
          {waiting.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              now={now}
              busy={busy === r.id}
              onAccept={() => void accept(r)}
              onReject={() => setRejecting(r)}
            />
          ))}
        </View>
      ) : null}
      {channels.requestsError ? <Notice kind="warning" message={`Couldn't load orders waiting for you: ${channels.requestsError}`} /> : null}
      {canBoard ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {BOARD_SECTIONS.map((s) => (
            <Chip key={s.stage} label={`${s.label} · ${counts[s.stage]}`} selected={stage === s.stage} onPress={() => setStage(s.stage)} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  const emptyTitle =
    stage === "NEW" ? "No new orders" : stage === "PREPARING" ? "Nothing cooking" : stage === "PACKED" ? "Nothing waiting for a rider" : "Nothing handed over yet";

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Row style={{ gap: space.sm }}>
            <AppText variant="h2">Online orders</AppText>
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
          {canBoard ? <AppText variant="muted">{counts.NEW + counts.PREPARING + counts.PACKED} active</AppText> : null}
        </Row>
        {error && orders ? <Notice kind="warning" message={`Live refresh failed: ${error}`} /> : null}
        {actionError ? <Notice kind="error" message={actionError} /> : null}
      </View>
      <FlatList
        data={canBoard ? visible : []}
        keyExtractor={(o) => o.orderId}
        contentContainerStyle={{ padding: space.md, gap: space.md, paddingBottom: space.xl * 2 }}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[t.primary]} tintColor={t.primary} />}
        ListEmptyComponent={
          canBoard ? (
            <EmptyState icon="globe-outline" title={emptyTitle} message="Zomato, Swiggy, ONDC and your own online orders appear here instantly." />
          ) : waiting.length ? null : (
            <EmptyState icon="checkmark-done-outline" title="All caught up" message="QR and online orders that need you appear here." />
          )
        }
        renderItem={({ item: o }) => (
          <BoardOrderCard
            order={o}
            now={now}
            busy={busy === o.orderId}
            onPacked={() => void packed(o)}
            onHandover={() => setHandover(o)}
          />
        )}
      />
      <HandoverSheet order={handover} onClose={() => setHandover(null)} onHandover={(name) => handedOver(handover!, name)} />
      <RejectSheet request={rejecting} onClose={() => setRejecting(null)} onReject={(reason) => channels.reject(rejecting!.id, reason)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1 },
  live: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
});

export default OnlineOrdersScreen;
