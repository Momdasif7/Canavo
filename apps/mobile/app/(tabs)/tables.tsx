import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, Chip, EmptyState, ErrorState, Input, Loading, Notice, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { inrShort } from "../../src/lib/format";
import { useSocketEvent, useSocketReconnect } from "../../src/lib/socket";
import type { Floor, FloorTable, TableStatus } from "../../src/lib/types";
import { useOffline } from "../../src/offline/OfflineContext";
import { isIndianMobile } from "../../src/pos/CartContext";
import { font, radius, space, TAP, useTheme, type Palette } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

const POLL_MS = 30_000;

function tableStatusColor(t: Palette, status: TableStatus, hasSession: boolean) {
  if (hasSession || status === "OCCUPIED") return t.primary;
  if (status === "NEEDS_ATTENTION") return t.danger;
  if (status === "RESERVED") return t.info;
  return t.success;
}

const STATUS_LABEL: Record<TableStatus, string> = {
  AVAILABLE: "Free",
  OCCUPIED: "Occupied",
  NEEDS_ATTENTION: "Attention",
  RESERVED: "Reserved",
};

/** Minutes since the tab opened, ticking locally between refreshes. */
function minutesSince(iso: string, now: number) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

function kotSummary(k: Partial<Record<string, number>>) {
  const parts: string[] = [];
  if (k.RECEIVED) parts.push(`${k.RECEIVED} new`);
  if (k.PREPARING) parts.push(`${k.PREPARING} cooking`);
  if (k.READY) parts.push(`${k.READY} ready`);
  return parts.join(" · ");
}

function Tables() {
  const t = useTheme();
  const { outlet } = useSignedIn();
  const { online } = useOffline();
  const { width } = useWindowDimensions();
  const columns = width >= 700 ? 4 : width >= 380 ? 3 : 2;
  const [floor, setFloor] = useState<Floor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [area, setArea] = useState<string | "ALL">("ALL");
  const [now, setNow] = useState(Date.now());
  const [opening, setOpening] = useState<FloorTable | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setFloor(await endpoints.floor());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setFloor(null);
    void load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, outlet?.id]);

  // Bursts of table:updated (a KOT round fires several) collapse into one reload.
  useSocketEvent("table:updated", () => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(), 300);
  });
  // Events sent while the socket was down are lost: reload on every (re)connect.
  useSocketReconnect(() => void load());

  const tables = useMemo(() => {
    if (!floor) return [];
    const list = floor.areas.filter((a) => area === "ALL" || (a.id ?? "none") === area).flatMap((a) => a.tables);
    return list;
  }, [floor, area]);

  const onTap = (table: FloorTable) => {
    void Haptics.selectionAsync();
    if (table.session) router.push({ pathname: "/table/[sessionId]", params: { sessionId: table.session.id } });
    else setOpening(table);
  };

  if (!floor && error) return <Screen scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!floor) return <Screen scroll={false}><Loading label="Loading tables…" /></Screen>;

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="h2">Tables</AppText>
          <AppText variant="muted">
            <AppText style={{ fontWeight: "800" }} color={t.primary}>{floor.stats.occupied}</AppText> occupied ·{" "}
            <AppText style={{ fontWeight: "800" }} color={t.success}>{floor.stats.available}</AppText> free
          </AppText>
        </Row>
        {floor.areas.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            <Chip label="All areas" selected={area === "ALL"} onPress={() => setArea("ALL")} />
            {floor.areas.map((a) => (
              <Chip key={a.id ?? "none"} label={a.name} selected={area === (a.id ?? "none")} onPress={() => setArea(a.id ?? "none")} />
            ))}
          </ScrollView>
        ) : null}
        {error ? <Notice kind="warning" message={`Live refresh failed: ${error}`} /> : null}
        {!online ? <Notice kind="warning" message="Offline — running tabs need a connection." /> : null}
      </View>
      <FlatList
        key={columns}
        data={tables}
        numColumns={columns}
        keyExtractor={(tb) => tb.id}
        contentContainerStyle={{ padding: space.md, paddingBottom: space.xl * 2 }}
        columnWrapperStyle={{ gap: space.sm }}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
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
        ListEmptyComponent={<EmptyState icon="grid-outline" title="No tables" message="Add tables from the web dashboard (Floor plan)." />}
        renderItem={({ item: tb }) => {
          const s = tb.session;
          const color = tableStatusColor(t, tb.status, !!s);
          const mins = s ? minutesSince(s.openedAt, now) : 0;
          const late = mins >= 90;
          return (
            <Pressable
              onPress={() => onTap(tb)}
              accessibilityRole="button"
              accessibilityLabel={`Table ${tb.label}, ${s ? `occupied ${mins} minutes, ${s.guests} guests` : STATUS_LABEL[tb.status]}`}
              style={({ pressed }) => [
                styles.tile,
                { flex: 1 / columns, backgroundColor: t.surface, borderColor: color, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Row style={{ justifyContent: "space-between" }}>
                <AppText style={{ fontSize: font.xl, fontWeight: "900" }} numberOfLines={1}>
                  {s && s.label !== tb.label ? s.label : tb.label}
                </AppText>
                <View style={[styles.dot, { backgroundColor: color }]} />
              </Row>
              {s ? (
                <>
                  <Row style={{ gap: 4 }}>
                    <Ionicons name="people" size={14} color={t.textMuted} />
                    <AppText variant="small">
                      {s.guests}/{tb.capacity}
                    </AppText>
                    <Ionicons name="timer-outline" size={14} color={late ? t.danger : t.textMuted} style={{ marginLeft: 6 }} />
                    <AppText variant="small" color={late ? t.danger : undefined} style={{ fontWeight: late ? "800" : "400" }}>
                      {mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`}
                    </AppText>
                  </Row>
                  <AppText variant="price" style={{ fontSize: font.md + 1 }}>
                    {inrShort(s.runningTotal)}
                  </AppText>
                  {kotSummary(s.kotStatus) ? (
                    <AppText variant="small" numberOfLines={1} color={s.kotStatus.READY ? t.success : undefined}>
                      {kotSummary(s.kotStatus)}
                    </AppText>
                  ) : null}
                  {s.readyToClose ? <AppText variant="small" color={t.success} style={{ fontWeight: "800" }}>Paid · close tab</AppText> : null}
                </>
              ) : (
                <>
                  <AppText variant="small">{tb.capacity} seats</AppText>
                  <AppText style={{ fontWeight: "800", color }}>{STATUS_LABEL[tb.status]}</AppText>
                  {tb.upcomingReservation ? (
                    <AppText variant="small" numberOfLines={2} color={t.info}>
                      {tb.upcomingReservation.customerName} ({tb.upcomingReservation.partySize}){" "}
                      {tb.upcomingReservation.minutesAway >= 0 ? `in ${tb.upcomingReservation.minutesAway}m` : "now"}
                    </AppText>
                  ) : null}
                </>
              )}
              {tb.waiter || s?.waiter ? (
                <AppText variant="small" numberOfLines={1}>
                  {(s?.waiter ?? tb.waiter)?.name}
                </AppText>
              ) : null}
            </Pressable>
          );
        }}
      />
      <OpenTableSheet
        table={opening}
        onClose={() => setOpening(null)}
        onOpened={(sessionId) => {
          setOpening(null);
          void load();
          router.push({ pathname: "/table/[sessionId]", params: { sessionId } });
        }}
      />
    </Screen>
  );
}

function OpenTableSheet({ table, onClose, onOpened }: { table: FloorTable | null; onClose: () => void; onOpened: (sessionId: string) => void }) {
  const t = useTheme();
  const [guests, setGuests] = useState(2);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!table) return;
    setGuests(Math.min(2, table.capacity));
    setName(table.upcomingReservation?.customerName ?? "");
    setPhone("");
    setError(null);
  }, [table]);

  if (!table) return null;

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await endpoints.openTable(table.id, {
        guests,
        customerName: name.trim() || undefined,
        customerPhone: isIndianMobile(phone) ? phone : undefined,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onOpened(s.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!table} onClose={onClose} title={`Open table ${table.label}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        {table.upcomingReservation ? (
          <Notice
            kind="info"
            message={`Reserved for ${table.upcomingReservation.customerName} (${table.upcomingReservation.partySize}). Seat reservations from the web dashboard to carry over their advance and pre-order.`}
          />
        ) : null}
        <AppText variant="h3">Guests</AppText>
        <Row style={{ justifyContent: "center", gap: space.lg }}>
          <Pressable onPress={() => setGuests((g) => Math.max(1, g - 1))} style={[styles.step, { borderColor: t.border }]} accessibilityLabel="Fewer guests">
            <Ionicons name="remove" size={28} color={t.text} />
          </Pressable>
          <AppText style={{ fontSize: 40, fontWeight: "900", minWidth: 60, textAlign: "center" }}>{guests}</AppText>
          <Pressable onPress={() => setGuests((g) => Math.min(100, g + 1))} style={[styles.step, { borderColor: t.primary, backgroundColor: t.primary }]} accessibilityLabel="More guests">
            <Ionicons name="add" size={28} color={t.primaryText} />
          </Pressable>
        </Row>
        {guests > table.capacity ? <AppText variant="small" color={t.warning} style={{ textAlign: "center" }}>More guests than seats ({table.capacity}).</AppText> : null}
        <Input placeholder="Customer name (optional)" value={name} onChangeText={setName} maxLength={100} />
        <Input
          placeholder="Customer mobile (optional)"
          value={phone}
          onChangeText={(v) => setPhone(v.replace(/\D/g, "").slice(0, 10))}
          keyboardType="phone-pad"
          maxLength={10}
        />
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Open tab" icon="restaurant-outline" size="xl" loading={busy} onPress={open} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tile: { minHeight: 128, borderRadius: radius.md, borderWidth: 2, borderLeftWidth: 6, padding: space.md, gap: 4 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  step: { width: TAP + 8, height: TAP + 8, borderRadius: radius.md, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["table:serve"], Tables);
