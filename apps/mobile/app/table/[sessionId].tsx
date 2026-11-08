import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, Card, Chip, ErrorState, Input, Loading, Notice, Row, Segmented } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { kvGet } from "../../src/lib/db";
import { formatTime, humanize, inr } from "../../src/lib/format";
import { useSocketEvent, useSocketReconnect } from "../../src/lib/socket";
import type { FloorTable, Kot, KotStatus, SessionDetail, SessionItem, SessionOrder } from "../../src/lib/types";
import { isIndianMobile } from "../../src/pos/CartContext";
import { showGst } from "../../src/pos/localBill";
import { useCurrentOutlet } from "../../src/pos/useOutlet";
import { font, radius, space, TAP, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

type BillMode = "FULL" | "BY_SEAT" | "BY_ITEMS" | "EQUAL";

const VOID_REASONS = ["Customer changed mind", "Wrong item entered", "Out of stock", "Quality issue"];

function paidOf(o: SessionOrder) {
  return o.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0);
}

function TableSession() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const t = useTheme();
  const { allowed } = useSignedIn();
  const canVoid = allowed("order:cancel");
  const canBill = allowed("order:create");
  const canCollect = allowed("payment:collect");
  const [s, setS] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<SessionItem | null>(null);
  const [billOpen, setBillOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<null | "transfer" | "merge">(null);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [advanceUsed, setAdvanceUsed] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      setS(await endpoints.session(sessionId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [sessionId]);

  // Reload whenever the screen regains focus (back from add items / payment).
  useFocusEffect(
    useCallback(() => {
      void load();
      if (sessionId) void kvGet<boolean>(`advance:${sessionId}`).then((r) => setAdvanceUsed(Boolean(r?.value)));
    }, [load, sessionId]),
  );

  useSocketEvent("table:updated", (p) => {
    if (!s || p.sessionId === s.id || p.tableIds.some((id) => id === s.tableId || s.mergedTableIds.includes(id))) void load();
  });
  useSocketReconnect(() => void load());

  const unbilled = useMemo(() => s?.items.filter((i) => !i.billedOrderId) ?? [], [s]);
  const rounds = useMemo(() => {
    if (!s) return [];
    const byKot = new Map<string, SessionItem[]>();
    for (const i of s.items) byKot.set(i.kotId ?? "none", [...(byKot.get(i.kotId ?? "none") ?? []), i]);
    const list: { kot: Kot | null; items: SessionItem[] }[] = s.kots
      .filter((k) => byKot.has(k.id) || k.items.some((x) => x.voided))
      .map((k) => ({ kot: k, items: byKot.get(k.id) ?? [] }));
    if (byKot.has("none")) list.push({ kot: null, items: byKot.get("none")! });
    return list;
  }, [s]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(null);
    }
  };

  const collect = (orderId: string, split?: number[]) => {
    if (!s) return;
    const advance = s.advancePaid > 0 && !advanceUsed ? s.advancePaid : 0;
    router.push({
      pathname: "/payment/[orderId]",
      params: {
        orderId,
        sessionId: s.id,
        ...(advance ? { advance: String(advance) } : {}),
        ...(split?.length ? { split: split.join(",") } : {}),
      },
    });
  };

  const closeTab = () =>
    run("close", async () => {
      if (!s) return;
      await endpoints.closeSession(s.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    });

  if (error && !s) return <Screen edges={[]} scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!s) return <Screen edges={[]} scroll={false}><Loading label="Loading tab…" /></Screen>;

  const closed = s.status !== "OPEN";
  const openOrders = s.orders.filter((o) => o.status === "OPEN");

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: `Table ${s.label}` }} />
      <Card style={{ gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <AppText variant="h2">Table {s.label}</AppText>
            <AppText variant="muted">
              Opened {formatTime(s.openedAt)} · {s.openedMinutes} min{s.waiter ? ` · ${s.waiter.name}` : ""}
            </AppText>
            {s.customerName || s.customerPhone ? (
              <AppText variant="small">
                {[s.customerName, s.customerPhone].filter(Boolean).join(" · ")}
              </AppText>
            ) : null}
          </View>
          <Pressable
            onPress={() => !closed && setGuestsOpen(true)}
            style={[styles.guests, { borderColor: t.border }]}
            accessibilityRole="button"
            accessibilityLabel={`${s.guests} guests. Change`}
          >
            <Ionicons name="people" size={20} color={t.primary} />
            <AppText style={{ fontWeight: "900", fontSize: font.xl }}>{s.guests}</AppText>
          </Pressable>
        </Row>
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="muted">{s.unbilledCount ? `Unbilled (${s.unbilledCount} lines)` : "Running total"}</AppText>
          <AppText variant="price" style={{ fontSize: 26 }}>
            {inr(s.unbilledCount ? s.unbilledEstimate.grandTotal : s.estimate.grandTotal)}
          </AppText>
        </Row>
        {s.advancePaid > 0 ? (
          <AppText variant="small" color={t.success}>
            Reservation advance {inr(s.advancePaid)} {advanceUsed ? "· applied" : "· apply it on the bill"}
          </AppText>
        ) : null}
      </Card>

      {closed ? (
        <View style={{ gap: space.sm }}>
          <Notice kind="success" title="Tab closed" message="All bills are paid and the table is free again." />
          <Button title="Back to tables" icon="grid-outline" size="lg" onPress={() => router.replace("/(tabs)/tables")} />
        </View>
      ) : null}
      {actionError ? <Notice kind="error" message={actionError} /> : null}

      {!closed ? (
        <View style={{ gap: space.sm }}>
          <Button
            title="Add items"
            icon="add-circle-outline"
            size="xl"
            onPress={() => router.push({ pathname: "/table/add", params: { sessionId: s.id, label: s.label, guests: String(s.guests) } })}
          />
          <Row>
            <Button
              title="Bill"
              icon="receipt-outline"
              variant="success"
              style={{ flex: 1 }}
              disabled={!canBill || unbilled.length === 0}
              onPress={() => setBillOpen(true)}
            />
            <Button title="Move" icon="swap-horizontal" variant="secondary" style={{ flex: 1 }} onPress={() => setMoveMode("transfer")} />
            <Button title="Merge" icon="git-merge-outline" variant="secondary" style={{ flex: 1 }} onPress={() => setMoveMode("merge")} />
          </Row>
        </View>
      ) : null}

      {s.orders.length ? (
        <Card style={{ gap: space.sm }}>
          <AppText variant="h3">Bills</AppText>
          {s.orders.map((o) => {
            const paid = paidOf(o);
            return (
              <Row key={o.id} style={{ justifyContent: "space-between", minHeight: TAP }}>
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontWeight: "700" }}>{o.invoiceNumber}</AppText>
                  <AppText variant="small">
                    {inr(o.grandTotal)} · {o.status === "OPEN" ? (paid ? `${inr(o.grandTotal - paid)} due` : "unpaid") : humanize(o.status)}
                  </AppText>
                </View>
                {o.status === "OPEN" && canCollect ? (
                  <Button title="Collect" icon="cash-outline" size="md" variant="success" onPress={() => collect(o.id)} />
                ) : (
                  <Ionicons name={o.status === "PAID" ? "checkmark-circle" : "close-circle"} size={26} color={o.status === "PAID" ? t.success : t.danger} />
                )}
              </Row>
            );
          })}
        </Card>
      ) : null}

      {s.readyToClose && !closed ? (
        <Button title="Close tab · free the table" icon="checkmark-done" size="lg" variant="success" loading={busy === "close"} onPress={closeTab} />
      ) : !closed && s.items.length === 0 && openOrders.length === 0 ? (
        <Button
          title="Close empty tab"
          icon="close-circle-outline"
          variant="ghost"
          loading={busy === "close"}
          onPress={() =>
            Alert.alert("Close this tab?", "Nothing was ordered. The table becomes free.", [
              { text: "Cancel", style: "cancel" },
              { text: "Close", style: "destructive", onPress: closeTab },
            ])
          }
        />
      ) : null}

      {rounds.length === 0 ? (
        <Notice kind="info" message="No items yet. Tap “Add items” to send the first round to the kitchen." />
      ) : (
        rounds.map(({ kot, items }) => (
          <Card key={kot?.id ?? "none"} style={{ gap: space.sm }}>
            <Row style={{ justifyContent: "space-between" }}>
              <AppText variant="h3">{kot ? `KOT #${kot.kotNumber}` : "Items"}</AppText>
              {kot ? (
                <Row style={{ gap: 6 }}>
                  <AppText variant="small">
                    {humanize(kot.station)} · {formatTime(kot.createdAt)}
                  </AppText>
                  <KotBadge status={kot.status} />
                </Row>
              ) : null}
            </Row>
            {items.map((i) => (
              <ItemRow key={i.id} item={i} canVoid={canVoid && !closed && !i.billedOrderId} onVoid={() => setVoiding(i)} />
            ))}
            {kot?.items
              .filter((x) => x.voided)
              .map((x, idx) => (
                <AppText key={`v${idx}`} variant="muted" style={{ textDecorationLine: "line-through" }}>
                  {x.quantity} × {x.name} (void)
                </AppText>
              ))}
          </Card>
        ))
      )}

      <VoidSheet
        item={voiding}
        onClose={() => setVoiding(null)}
        onConfirm={(reason) =>
          run("void", async () => {
            if (!voiding) return;
            setS(await endpoints.voidSessionItem(s.id, voiding.id, reason));
            setVoiding(null);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          })
        }
        busy={busy === "void"}
      />
      <BillSheet
        visible={billOpen}
        session={s}
        unbilled={unbilled}
        onClose={() => setBillOpen(false)}
        onBilled={(res) => {
          setBillOpen(false);
          setS(res.session);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (res.orders.length === 1 && canCollect) collect(res.orders[0].order.id, res.equalSplit);
          else if (res.orders.length > 1) Alert.alert(`${res.orders.length} bills raised`, "Collect each bill from the Bills list.");
        }}
      />
      <MoveSheet
        mode={moveMode}
        session={s}
        onClose={() => setMoveMode(null)}
        onDone={(next) => {
          setMoveMode(null);
          setS(next);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
      />
      <GuestsSheet
        visible={guestsOpen}
        initial={s.guests}
        onClose={() => setGuestsOpen(false)}
        onSave={(g) =>
          run("guests", async () => {
            setS(await endpoints.updateSession(s.id, { guests: g }));
            setGuestsOpen(false);
          })
        }
      />
    </Screen>
  );
}

function KotBadge({ status }: { status: KotStatus }) {
  const t = useTheme();
  const color = status === "RECEIVED" ? t.info : status === "PREPARING" ? t.warning : status === "READY" ? t.success : t.textMuted;
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{humanize(status)}</AppText>
    </View>
  );
}

function ItemRow({ item, canVoid, onVoid }: { item: SessionItem; canVoid: boolean; onVoid: () => void }) {
  const t = useTheme();
  return (
    <Row style={{ minHeight: 44, alignItems: "flex-start" }}>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontWeight: "700" }}>
          {item.quantity} × {item.name}
        </AppText>
        {item.addons.length ? <AppText variant="small">+ {item.addons.join(", ")}</AppText> : null}
        <Row style={{ gap: 6 }}>
          {item.seat ? (
            <View style={[styles.seat, { borderColor: t.primary }]}>
              <AppText style={{ fontSize: 12, fontWeight: "800" }} color={t.primary}>
                Seat {item.seat}
              </AppText>
            </View>
          ) : null}
          {item.notes ? <AppText variant="small">{item.notes}</AppText> : null}
          {item.billedOrderId ? <AppText variant="small" color={t.success} style={{ fontWeight: "800" }}>Billed</AppText> : null}
        </Row>
      </View>
      <AppText style={{ fontWeight: "800", fontVariant: ["tabular-nums"] }}>{inr(item.amount)}</AppText>
      {canVoid ? (
        <Pressable onPress={onVoid} hitSlop={8} style={styles.voidBtn} accessibilityRole="button" accessibilityLabel={`Void ${item.name}`}>
          <Ionicons name="trash-outline" size={20} color={t.danger} />
        </Pressable>
      ) : null}
    </Row>
  );
}

function VoidSheet({ item, onClose, onConfirm, busy }: { item: SessionItem | null; onClose: () => void; onConfirm: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [item]);
  if (!item) return null;
  return (
    <Sheet visible={!!item} onClose={onClose} title={`Void ${item.quantity} × ${item.name}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <AppText variant="muted">The kitchen sees the item struck through on its KOT. Voids are audited.</AppText>
        <Row style={{ flexWrap: "wrap" }}>
          {VOID_REASONS.map((r) => (
            <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(r)} />
          ))}
        </Row>
        <Input placeholder="Or type a reason" value={reason} onChangeText={setReason} maxLength={200} />
        <Button title="Void item" icon="trash-outline" variant="danger" size="lg" disabled={reason.trim().length < 3} loading={busy} onPress={() => onConfirm(reason.trim())} />
      </ScrollView>
    </Sheet>
  );
}

function BillSheet({
  visible,
  session,
  unbilled,
  onClose,
  onBilled,
}: {
  visible: boolean;
  session: SessionDetail;
  unbilled: SessionItem[];
  onClose: () => void;
  onBilled: (res: Awaited<ReturnType<typeof endpoints.billSession>>) => void;
}) {
  const t = useTheme();
  const [mode, setMode] = useState<BillMode>("FULL");
  const [seats, setSeats] = useState<number[]>([]);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [parts, setParts] = useState(2);
  const [phone, setPhone] = useState("");
  const [coupon, setCoupon] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seatList = useMemo(() => [...new Set(unbilled.map((i) => i.seat).filter((x): x is number => x != null))].sort((a, b) => a - b), [unbilled]);
  const hasShared = unbilled.some((i) => i.seat == null);

  useEffect(() => {
    if (!visible) return;
    setMode("FULL");
    setSeats([]);
    setItemIds([]);
    setParts(Math.max(2, Math.min(session.guests, 50)));
    setPhone(session.customerPhone ?? "");
    setCoupon("");
    setError(null);
  }, [visible, session.guests, session.customerPhone]);

  const singleBill = mode === "FULL" || mode === "EQUAL" || mode === "BY_ITEMS" || (mode === "BY_SEAT" && seats.length === 1);
  // GST wording only for a GST-registered outlet (and never before its settings are known).
  const gstOn = showGst({ documentType: "TAX_INVOICE" }, useCurrentOutlet());
  const selectedTotal = useMemo(() => {
    if (mode === "BY_ITEMS") return unbilled.filter((i) => itemIds.includes(i.id)).reduce((s, i) => s + i.amount, 0);
    if (mode === "BY_SEAT" && seats.length) return unbilled.filter((i) => i.seat != null && seats.includes(i.seat)).reduce((s, i) => s + i.amount, 0);
    return unbilled.reduce((s, i) => s + i.amount, 0);
  }, [mode, unbilled, itemIds, seats]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.billSession(session.id, {
        mode,
        ...(mode === "BY_SEAT" && seats.length ? { seats } : {}),
        ...(mode === "BY_ITEMS" ? { itemIds } : {}),
        ...(mode === "EQUAL" ? { parts } : {}),
        ...(isIndianMobile(phone) ? { customerPhone: phone } : {}),
        ...(singleBill && coupon.trim() ? { couponCode: coupon.trim().toUpperCase() } : {}),
      });
      onBilled(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    unbilled.length > 0 && (mode !== "BY_ITEMS" || itemIds.length > 0) && (mode !== "BY_SEAT" || seatList.length > 0 || hasShared);

  return (
    <Sheet visible={visible} onClose={onClose} title={`Bill table ${session.label}`} maxHeight="94%">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <Segmented
          options={[
            { value: "FULL", label: "Full" },
            { value: "BY_SEAT", label: "By seat" },
            { value: "BY_ITEMS", label: "Items" },
            { value: "EQUAL", label: "Equal" },
          ]}
          value={mode}
          onChange={(v) => setMode(v)}
        />
        {mode === "FULL" ? <AppText variant="muted">One bill for everything not yet billed.</AppText> : null}
        {mode === "BY_SEAT" ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="muted">
              One bill per seat{hasShared ? "; items without a seat go on a “Shared” bill" : ""}. Pick seats to bill only those now.
            </AppText>
            {seatList.length ? (
              <Row style={{ flexWrap: "wrap" }}>
                {seatList.map((n) => (
                  <Chip key={n} label={`Seat ${n}`} selected={seats.includes(n)} onPress={() => setSeats((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]))} />
                ))}
              </Row>
            ) : (
              <Notice kind="warning" message="No items have seat numbers — use Full or Items." />
            )}
          </View>
        ) : null}
        {mode === "BY_ITEMS" ? (
          <View style={{ gap: 6 }}>
            <AppText variant="muted">Tick the items for this bill.</AppText>
            {unbilled.map((i) => {
              const on = itemIds.includes(i.id);
              return (
                <Pressable
                  key={i.id}
                  onPress={() => setItemIds((cur) => (on ? cur.filter((x) => x !== i.id) : [...cur, i.id]))}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={[styles.pick, { borderColor: on ? t.primary : t.border, backgroundColor: t.surface }]}
                >
                  <Ionicons name={on ? "checkbox" : "square-outline"} size={24} color={on ? t.primary : t.textMuted} />
                  <AppText style={{ flex: 1, fontWeight: "600" }}>
                    {i.quantity} × {i.name}
                    {i.seat ? ` · S${i.seat}` : ""}
                  </AppText>
                  <AppText style={{ fontWeight: "800" }}>{inr(i.amount)}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {mode === "EQUAL" ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="muted">One bill, collected in equal shares.</AppText>
            <Row style={{ justifyContent: "center", gap: space.lg }}>
              <Pressable onPress={() => setParts((p) => Math.max(2, p - 1))} style={[styles.step, { borderColor: t.border }]} accessibilityLabel="Fewer people">
                <Ionicons name="remove" size={26} color={t.text} />
              </Pressable>
              <AppText style={{ fontSize: 34, fontWeight: "900", minWidth: 60, textAlign: "center" }}>{parts}</AppText>
              <Pressable onPress={() => setParts((p) => Math.min(50, p + 1))} style={[styles.step, { borderColor: t.primary, backgroundColor: t.primary }]} accessibilityLabel="More people">
                <Ionicons name="add" size={26} color="#fff" />
              </Pressable>
            </Row>
            <AppText variant="small" style={{ textAlign: "center" }}>
              ≈ {inr(Math.ceil(selectedTotal / parts))} each before {gstOn ? "tax & " : ""}rounding
            </AppText>
          </View>
        ) : null}

        <Input
          placeholder="Customer mobile (loyalty, WhatsApp bill)"
          value={phone}
          onChangeText={(v) => setPhone(v.replace(/\D/g, "").slice(0, 10))}
          keyboardType="phone-pad"
          maxLength={10}
        />
        {singleBill ? (
          <Input placeholder="Coupon code (optional)" value={coupon} onChangeText={(v) => setCoupon(v.toUpperCase())} autoCapitalize="characters" maxLength={30} />
        ) : (
          <AppText variant="small">Coupons apply to a single bill — bill seats one at a time to use one.</AppText>
        )}
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="muted">{gstOn ? "Items selected (before tax)" : "Items selected"}</AppText>
          <AppText variant="price">{inr(selectedTotal)}</AppText>
        </Row>
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Raise bill" icon="receipt-outline" size="xl" variant="success" disabled={!canSubmit} loading={busy} onPress={submit} />
      </ScrollView>
    </Sheet>
  );
}

function MoveSheet({
  mode,
  session,
  onClose,
  onDone,
}: {
  mode: null | "transfer" | "merge";
  session: SessionDetail;
  onClose: () => void;
  onDone: (s: SessionDetail) => void;
}) {
  const [tables, setTables] = useState<FloorTable[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mode) return;
    setSelected([]);
    setError(null);
    setTables(null);
    endpoints
      .floor()
      .then((f) => setTables(f.areas.flatMap((a) => a.tables)))
      .catch((e) => setError(errorMessage(e)));
  }, [mode]);

  if (!mode) return null;
  const own = new Set([session.tableId, ...session.mergedTableIds]);
  const options = (tables ?? []).filter((tb) => !own.has(tb.id) && (mode === "merge" || !tb.session));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = mode === "transfer" ? await endpoints.transferSession(session.id, selected[0]) : await endpoints.mergeSession(session.id, selected);
      onDone(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!mode} onClose={onClose} title={mode === "transfer" ? `Move ${session.label} to…` : `Merge into ${session.label}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }}>
        <AppText variant="muted">
          {mode === "transfer"
            ? "The whole tab moves to a free table."
            : "Selected tables join this tab. Their open tabs (items, KOTs, bills) are combined into this one."}
        </AppText>
        {!tables && !error ? <Loading /> : null}
        <Row style={{ flexWrap: "wrap" }}>
          {options.map((tb) => (
            <Chip
              key={tb.id}
              label={`${tb.label}${tb.session ? " (occupied)" : ""}`}
              selected={selected.includes(tb.id)}
              onPress={() =>
                setSelected((cur) => (mode === "transfer" ? [tb.id] : cur.includes(tb.id) ? cur.filter((x) => x !== tb.id) : [...cur, tb.id]))
              }
            />
          ))}
        </Row>
        {tables && !options.length ? <AppText variant="muted">No {mode === "transfer" ? "free " : ""}tables available.</AppText> : null}
        {error ? <Notice kind="error" message={error} /> : null}
        <Button
          title={mode === "transfer" ? "Move tab" : `Merge ${selected.length || ""} table(s)`}
          icon={mode === "transfer" ? "swap-horizontal" : "git-merge-outline"}
          size="lg"
          disabled={!selected.length}
          loading={busy}
          onPress={submit}
        />
      </ScrollView>
    </Sheet>
  );
}

function GuestsSheet({ visible, initial, onClose, onSave }: { visible: boolean; initial: number; onClose: () => void; onSave: (g: number) => void }) {
  const t = useTheme();
  const [g, setG] = useState(initial);
  useEffect(() => {
    if (visible) setG(initial);
  }, [visible, initial]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Guests">
      <View style={{ paddingHorizontal: space.lg, gap: space.lg }}>
        <Row style={{ justifyContent: "center", gap: space.lg }}>
          <Pressable onPress={() => setG((x) => Math.max(1, x - 1))} style={[styles.step, { borderColor: t.border }]} accessibilityLabel="Fewer guests">
            <Ionicons name="remove" size={28} color={t.text} />
          </Pressable>
          <AppText style={{ fontSize: 40, fontWeight: "900", minWidth: 60, textAlign: "center" }}>{g}</AppText>
          <Pressable onPress={() => setG((x) => Math.min(100, x + 1))} style={[styles.step, { borderColor: t.primary, backgroundColor: t.primary }]} accessibilityLabel="More guests">
            <Ionicons name="add" size={28} color="#fff" />
          </Pressable>
        </Row>
        <Button title="Save" size="lg" onPress={() => onSave(g)} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  guests: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: TAP },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  seat: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 },
  voidBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pick: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: TAP },
  step: { width: TAP + 8, height: TAP + 8, borderRadius: radius.md, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["table:serve"], TableSession);
