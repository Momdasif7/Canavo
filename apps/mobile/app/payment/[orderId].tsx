import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import QRCode from "react-native-qrcode-svg";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Chip, ErrorState, Input, Loading, Notice, Row, Segmented } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { apiAbsoluteUrl, IS_DEV } from "../../src/lib/config";
import { kvGet, kvSet } from "../../src/lib/db";
import { inr, inrShort, parseRupees } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { Order, PaymentMode, UpiQrResponse } from "../../src/lib/types";
import { font, radius, space, TAP, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";
import { useOffline } from "../../src/offline/OfflineContext";
import { codAvailable, codCopy, isCod } from "../../src/pos/cod";
import { AssignStatus } from "../../src/delivery/AssignStatus";

type Tab = "CASH" | "UPI" | "CARD" | "SPLIT";

function cashSuggestions(due: number): number[] {
  const up = (step: number) => Math.ceil(due / step) * step;
  const all = [due, up(1000), up(5000), up(10000), up(50000), 200000].filter((v) => v >= due);
  return [...new Set(all)].slice(0, 5);
}

function Payment() {
  const params = useLocalSearchParams<{ orderId: string; sessionId?: string; advance?: string; split?: string }>();
  const { orderId, sessionId } = params;
  const advance = Number(params.advance ?? 0) || 0;
  /** EQUAL split from a table bill: share amounts in paise, summing to the total */
  const shares = useMemo(() => (params.split ? params.split.split(",").map(Number).filter((n) => n > 0) : []), [params.split]);
  const t = useTheme();
  const { online } = useOffline();
  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("CASH");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  // Cash
  const [tenderedText, setTenderedText] = useState("");
  // Card
  const [cardRef, setCardRef] = useState("");
  // Split
  const [splitCashText, setSplitCashText] = useState("");
  const [splitRest, setSplitRest] = useState<"CARD" | "UPI">("CARD");
  // UPI
  const [qr, setQr] = useState<UpiQrResponse | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  // Equal split: which share is being collected (null = the whole balance)
  const [shareIndex, setShareIndex] = useState<number | null>(null);
  const [sharesPaid, setSharesPaid] = useState(0);
  const [advanceUsed, setAdvanceUsed] = useState(false);

  const balance = order?.balance ?? order?.grandTotal ?? 0;
  /** Amount being collected now: the selected equal share, else the whole balance. */
  const due = shareIndex != null ? Math.min(shares[shareIndex] ?? balance, balance) : balance;
  const advanceKey = sessionId ? `advance:${sessionId}` : null;

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoadError(null);
    try {
      const o = await endpoints.getOrder(orderId);
      setOrder(o);
      if (o.status === "PAID") finish(0);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The reservation advance is recorded once per table session, even across split bills.
  useEffect(() => {
    if (!advanceKey) return;
    void kvGet<boolean>(advanceKey).then((r) => setAdvanceUsed(Boolean(r?.value)));
  }, [advanceKey]);
  const advanceOnBill = order?.payments.some((p) => p.reference === "ADVANCE" && p.status === "SUCCESS") ?? false;
  const advanceAvailable = advance > 0 && !advanceUsed && !advanceOnBill && order?.status === "OPEN";

  const finish = (change: number) => {
    if (done.current || !orderId) return;
    done.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace({ pathname: "/receipt/[orderId]", params: { orderId, change: String(change), ...(sessionId ? { sessionId } : {}) } });
  };

  const pay = async (payments: { mode: PaymentMode; amount: number; reference?: string }[], tendered?: number) => {
    if (!orderId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.pay(orderId, payments, tendered);
      if (res.paid) finish(res.change);
      else {
        setOrder({ ...res.order, balance: res.balance });
        if (shareIndex != null) {
          setSharesPaid((n) => n + 1);
          setShareIndex(null);
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return res;
      }
    } catch (e) {
      setError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  // ----- UPI -----
  const createQr = useCallback(async () => {
    if (!orderId) return;
    setQr(null);
    setQrError(null);
    try {
      setQr(await endpoints.upiQr(orderId, due < balance ? due : undefined));
    } catch (e) {
      setQrError(errorMessage(e));
    }
  }, [orderId, due, balance]);

  useEffect(() => {
    if (tab === "UPI" && !qr && order?.status === "OPEN") void createQr();
  }, [tab, qr, order?.status, createQr]);

  // Poll every 3 s while a QR is on screen (socket `order:paid` usually wins).
  useEffect(() => {
    if (tab !== "UPI" || !qr || !orderId) return;
    const id = setInterval(async () => {
      try {
        const s = await endpoints.paymentStatus(orderId);
        if (s.status === "PAID") finish(0);
        else if (s.balance < balance) {
          // A share was paid by UPI: move on to the next one.
          setQr(null);
          if (shareIndex != null) {
            setSharesPaid((n) => n + 1);
            setShareIndex(null);
          }
          void load();
        }
      } catch {
        // transient; keep polling
      }
    }, 3000);
    return () => clearInterval(id);
  }, [tab, qr, orderId, balance, shareIndex, load]);

  useSocketEvent("order:paid", (p) => {
    if (p.id === orderId) finish(0);
  });

  // ----- Cash on Delivery -----
  const openCod = () => {
    if (done.current || !orderId) return;
    done.current = true;
    router.replace({ pathname: "/cod/[orderId]", params: { orderId } });
  };

  const markCod = async () => {
    if (!orderId || busy) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setError(null);
    try {
      await endpoints.markCod(orderId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      openCod();
    } catch (e) {
      setError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const upiAction = async (fn: () => Promise<{ paid: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.paid) finish(0);
      else await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <Screen edges={[]} scroll={false}><ErrorState message={loadError} onRetry={load} /></Screen>;
  if (!order) return <Screen edges={[]} scroll={false}><Loading /></Screen>;

  const tendered = parseRupees(tenderedText);
  const change = tendered != null ? tendered - due : null;
  const splitCash = parseRupees(splitCashText) ?? 0;
  const splitRemainder = balance - splitCash;
  const deliveryOpen = !!order.delivery && order.delivery.status !== "DELIVERED" && order.delivery.status !== "CANCELLED";
  // COD: online delivery orders only, whole balance (not mid equal-split).
  const showCod = codAvailable(order.orderType, online) && deliveryOpen && order.status === "OPEN" && balance > 0 && shareIndex == null;
  const alreadyCod = isCod(order);

  return (
    <Screen edges={[]}>
      <Card style={{ alignItems: "center", gap: 4 }}>
        <AppText variant="muted">Bill {order.invoiceNumber}</AppText>
        <AppText variant="priceLg">{inr(balance)}</AppText>
        {balance !== order.grandTotal ? <AppText variant="small">of {inr(order.grandTotal)} · rest already paid</AppText> : null}
      </Card>
      {order.orderType === "DELIVERY" ? <AssignStatus order={order} /> : null}

      {advanceAvailable ? (
        <Card style={{ gap: space.sm, borderColor: t.success }}>
          <AppText variant="h3">Reservation advance</AppText>
          <AppText variant="muted">
            {inr(advance)} was paid when the table was booked. Record it against this bill first.
          </AppText>
          <Button
            title={`Apply advance ${inr(Math.min(advance, balance))}`}
            icon="bookmark-outline"
            variant="success"
            loading={busy}
            onPress={async () => {
              const res = await pay([{ mode: "CASH", amount: Math.min(advance, balance), reference: "ADVANCE" }]);
              if (advanceKey) await kvSet(advanceKey, true);
              setAdvanceUsed(true);
              if (res) setQr(null);
            }}
          />
        </Card>
      ) : null}

      {shares.length > 1 ? (
        <Card style={{ gap: space.sm }}>
          <AppText variant="h3">Split equally · {shares.length} people</AppText>
          <AppText variant="small">
            {sharesPaid} of {shares.length} paid. Pick a share, then collect it by cash, UPI or card.
          </AppText>
          <Row style={{ flexWrap: "wrap" }}>
            <Chip label="Whole balance" selected={shareIndex == null} onPress={() => { setShareIndex(null); setQr(null); }} />
            {shares.map((amt, i) =>
              i < sharesPaid ? null : (
                <Chip
                  key={i}
                  label={`Person ${i + 1} · ${inrShort(Math.min(amt, balance))}`}
                  selected={shareIndex === i}
                  onPress={() => {
                    setShareIndex(i);
                    setTenderedText("");
                    setQr(null);
                  }}
                />
              ),
            )}
          </Row>
          {shareIndex != null ? (
            <AppText style={{ fontWeight: "800" }} color={t.primary}>
              Collecting {inr(due)} now
            </AppText>
          ) : null}
        </Card>
      ) : null}

      {showCod ? (
        <Pressable
          onPress={alreadyCod ? openCod : markCod}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={alreadyCod ? "Already Cash on Delivery. Open COD slip" : "Cash on Delivery"}
          style={({ pressed }) => [
            styles.cod,
            { borderColor: t.warning, backgroundColor: pressed ? t.surfaceAlt : t.warningBg, opacity: busy ? 0.6 : 1 },
          ]}
        >
          <View style={[styles.codIcon, { backgroundColor: t.warning }]}>
            <Ionicons name="bicycle" size={28} color="#fff" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <AppText style={{ fontWeight: "900", fontSize: font.lg }} color={t.warning}>
              {alreadyCod ? "COD · already marked" : "Cash on Delivery (COD)"}
            </AppText>
            <AppText color={t.warning} style={{ fontWeight: "600" }}>
              {codCopy(order.delivery?.agent?.name, balance)}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" size={24} color={t.warning} />
        </Pressable>
      ) : null}
      {showCod ? <AppText variant="small" style={{ textAlign: "center" }}>or collect now</AppText> : null}

      <Segmented
        options={[
          { value: "CASH", label: "Cash" },
          { value: "UPI", label: "UPI" },
          { value: "CARD", label: "Card" },
          { value: "SPLIT", label: "Split" },
        ]}
        value={tab}
        onChange={(v) => {
          setTab(v);
          setError(null);
        }}
      />

      {tab === "CASH" ? (
        <Card style={{ gap: space.md }}>
          <Input label="Cash received (₹)" value={tenderedText} onChangeText={setTenderedText} keyboardType="decimal-pad" placeholder={(due / 100).toFixed(2)} />
          <Row style={{ flexWrap: "wrap" }}>
            {cashSuggestions(due).map((v) => (
              <Chip key={v} label={v === due ? "Exact" : inrShort(v)} onPress={() => setTenderedText((v / 100).toString())} selected={tendered === v} />
            ))}
          </Row>
          {change != null ? (
            <View style={[styles.change, { backgroundColor: change >= 0 ? t.successBg : t.dangerBg }]}>
              <AppText variant="h3" color={change >= 0 ? t.success : t.danger}>
                {change >= 0 ? "Return change" : "Short by"}
              </AppText>
              <AppText variant="priceLg" style={{ fontSize: 34 }} color={change >= 0 ? t.success : t.danger}>
                {inr(Math.abs(change))}
              </AppText>
            </View>
          ) : null}
          <Button
            title="Cash received"
            icon="cash-outline"
            size="xl"
            variant="success"
            loading={busy}
            disabled={change != null && change < 0}
            onPress={() => {
              setTenderedText("");
              void pay([{ mode: "CASH", amount: due }], tendered ?? due);
            }}
          />
        </Card>
      ) : null}

      {tab === "UPI" ? (
        <Card style={{ alignItems: "center", gap: space.md }}>
          {qrError ? (
            <Notice kind="error" message={qrError} style={{ alignSelf: "stretch" }} />
          ) : !qr ? (
            <View style={{ height: 260, justifyContent: "center" }}>
              <Loading label="Creating UPI QR…" />
            </View>
          ) : (
            <>
              <View style={styles.qrBox}>
                {qr.imageUrl ? (
                  <Image source={{ uri: apiAbsoluteUrl(qr.imageUrl) }} style={{ width: 260, height: 260 }} resizeMode="contain" />
                ) : (
                  <QRCode value={qr.qrPayload} size={240} />
                )}
              </View>
              <AppText variant="h3">Scan with any UPI app · {inr(qr.amount)}</AppText>
              <AppText variant="small">Waiting for payment… this screen updates automatically.</AppText>
              {qr.mock ? <Notice kind="info" message="Test mode: no payment gateway configured." style={{ alignSelf: "stretch" }} /> : null}
            </>
          )}
          {qr && qr.mock && IS_DEV ? (
            <Button
              title="Simulate customer payment (dev)"
              variant="secondary"
              icon="flask-outline"
              loading={busy}
              style={{ alignSelf: "stretch" }}
              onPress={() => upiAction(() => endpoints.devSimulateUpi(order.id, qr.paymentId))}
            />
          ) : null}
          {qr ? (
            <Button
              title="Payment received — confirm"
              variant="success"
              icon="checkmark-done"
              loading={busy}
              style={{ alignSelf: "stretch" }}
              onPress={() => upiAction(() => endpoints.confirmUpi(order.id, qr.paymentId))}
            />
          ) : null}
          <Button title="New QR" variant="ghost" icon="refresh" size="md" onPress={createQr} />
        </Card>
      ) : null}

      {tab === "CARD" ? (
        <Card style={{ gap: space.md }}>
          <AppText variant="muted">Charge {inr(due)} on the card machine, then confirm.</AppText>
          <Input label="Approval / last 4 digits (optional)" value={cardRef} onChangeText={setCardRef} maxLength={100} />
          <Button
            title="Card payment done"
            icon="card-outline"
            size="xl"
            variant="success"
            loading={busy}
            onPress={() => pay([{ mode: "CARD", amount: due, reference: cardRef.trim() || undefined }])}
          />
        </Card>
      ) : null}

      {tab === "SPLIT" ? (
        <Card style={{ gap: space.md }}>
          <Input label="Cash part (₹)" value={splitCashText} onChangeText={setSplitCashText} keyboardType="decimal-pad" placeholder="0" />
          <AppText variant="muted">Rest ({inr(Math.max(0, splitRemainder))}) by:</AppText>
          <Row>
            <Chip label="Card" selected={splitRest === "CARD"} onPress={() => setSplitRest("CARD")} />
            <Chip label="UPI QR" selected={splitRest === "UPI"} onPress={() => setSplitRest("UPI")} />
          </Row>
          <Button
            title={splitRest === "CARD" ? "Record cash + card" : "Record cash, then show QR"}
            size="lg"
            variant="success"
            loading={busy}
            disabled={splitCash <= 0 || splitRemainder <= 0}
            onPress={async () => {
              if (splitRest === "CARD") {
                await pay([{ mode: "CASH", amount: splitCash }, { mode: "CARD", amount: splitRemainder }], splitCash);
              } else {
                const res = await pay([{ mode: "CASH", amount: splitCash }], splitCash);
                if (res && !res.paid) {
                  setQr(null);
                  setTab("UPI");
                }
              }
            }}
          />
          {splitCash > 0 && splitRemainder <= 0 ? <AppText variant="small" color={t.danger}>Cash part must be less than the total.</AppText> : null}
        </Card>
      ) : null}

      {error ? <Notice kind="error" message={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  change: { borderRadius: radius.md, padding: space.md, alignItems: "center" },
  qrBox: { backgroundColor: "#fff", padding: space.md, borderRadius: radius.md },
  cod: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 2, borderRadius: radius.lg, padding: space.md, minHeight: TAP + 24 },
  codIcon: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["payment:collect"], Payment);
