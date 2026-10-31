import React, { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { KHATA_SETTLE_MODES } from "@canavo/shared";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, Card, Chip, ErrorState, Input, Kpi, Loading, Notice, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatDate, humanize, inr, inrShort, parseRupees } from "../../src/lib/format";
import type { CustomerProfile } from "../../src/lib/types";
import { TierBadge } from "../../src/pos/CartExtras";
import { space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

type SettleMode = (typeof KHATA_SETTLE_MODES)[number];

function waReminderLink(phone: string, text: string) {
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { allowed, outlet } = useSignedIn();
  const canSettle = allowed("payment:collect");
  const [p, setP] = useState<CustomerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setP(await endpoints.customer(id));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const remind = async () => {
    if (!p) return;
    setReminding(true);
    setMessage(null);
    try {
      const res = await endpoints.remindKhata(p.customer.id);
      if (res.method === "sent") setMessage({ kind: "success", text: "Sent on WhatsApp." });
      else {
        await Linking.openURL(res.waLink);
        // e.g. "WhatsApp API failed — opened chat instead"
        if (res.error) setMessage({ kind: "info", text: res.error });
      }
    } catch (e) {
      // Fallback: compose the reminder locally.
      const text = `Hi ${p.customer.name ?? "there"}, a friendly reminder from ${outlet?.name ?? "us"}: ${inr(p.customer.khataBalance)} is pending on your khata. Thank you!`;
      try {
        await Linking.openURL(waReminderLink(p.customer.phone, text));
      } catch {
        setMessage({ kind: "error", text: errorMessage(e) });
      }
    } finally {
      setReminding(false);
    }
  };

  if (error && !p) return <Screen edges={[]} scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!p) return <Screen edges={[]} scroll={false}><Loading /></Screen>;
  const c = p.customer;
  const s = p.stats;

  return (
    <Screen edges={[]} refreshing={false} onRefresh={load}>
      <Stack.Screen options={{ title: c.name || `+91 ${c.phone}` }} />
      <Card style={{ gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="h2" style={{ flex: 1 }} numberOfLines={1}>
            {c.name || "Customer"}
          </AppText>
          <TierBadge tier={s.tier} />
        </Row>
        <AppText variant="muted">+91 {c.phone}</AppText>
        {c.blocked ? <Notice kind="error" message="Blocked — bills for this customer are refused." /> : null}
        {s.nextTier ? (
          <AppText variant="small">
            {inrShort(s.nextTier.remaining)} more spend to reach {humanize(s.nextTier.tier)}
          </AppText>
        ) : null}
      </Card>

      <View style={styles.kpis}>
        <Kpi label="Points" value={String(s.points)} hint={`worth ${inrShort(s.pointsValue)}`} accent={t.primary} />
        <Kpi label="Total spend" value={inrShort(s.totalSpend)} hint={`${s.visitCount} visits · avg ${inrShort(s.avgBill)}`} />
      </View>

      <Card style={{ gap: space.sm, borderColor: s.khataBalance > 0 ? t.warning : t.border }}>
        <Row style={{ justifyContent: "space-between" }}>
          <AppText variant="h3">Khata (credit)</AppText>
          <AppText variant="price" color={s.khataBalance > 0 ? t.warning : t.success}>
            {inr(s.khataBalance)}
          </AppText>
        </Row>
        <AppText variant="small">{s.khataLimit ? `Limit ${inr(s.khataLimit)}` : "No credit limit set"}</AppText>
        {message ? <Notice kind={message.kind} message={message.text} /> : null}
        {s.khataBalance > 0 ? (
          <Row>
            {canSettle ? <Button title="Settle" icon="cash-outline" variant="success" style={{ flex: 1 }} onPress={() => setSettleOpen(true)} /> : null}
            <Button title="Remind" icon="logo-whatsapp" variant="secondary" style={{ flex: 1 }} loading={reminding} onPress={remind} />
          </Row>
        ) : null}
        {p.khataLedger.slice(0, 8).map((k) => (
          <Row key={k.id} style={{ justifyContent: "space-between", minHeight: 32 }}>
            <AppText variant="small" style={{ flex: 1 }} numberOfLines={1}>
              {formatDate(k.createdAt)} · {k.note ?? (k.type === "DEBIT" ? "Bill on credit" : "Payment")}
              {k.mode ? ` · ${humanize(k.mode)}` : ""}
            </AppText>
            <AppText style={{ fontWeight: "800" }} color={k.type === "DEBIT" ? t.warning : t.success}>
              {k.type === "DEBIT" ? "+" : "−"}
              {inr(k.amount)}
            </AppText>
          </Row>
        ))}
      </Card>

      {p.favouriteItems.length ? (
        <Card style={{ gap: 6 }}>
          <AppText variant="h3">Usually orders</AppText>
          <AppText variant="muted">{p.favouriteItems.map((f) => `${f.name} (${f.quantity})`).join(", ")}</AppText>
        </Card>
      ) : null}

      {p.recentOrders.length ? (
        <Card style={{ gap: space.sm }}>
          <AppText variant="h3">Recent bills</AppText>
          {p.recentOrders.map((o) => (
            <Row key={o.id} style={{ justifyContent: "space-between", minHeight: 32 }}>
              <AppText variant="small">
                {o.invoiceNumber} · {formatDate(o.createdAt)}
              </AppText>
              <AppText style={{ fontWeight: "700" }} color={o.status === "CANCELLED" ? t.danger : undefined}>
                {inr(o.grandTotal)}
              </AppText>
            </Row>
          ))}
        </Card>
      ) : null}

      <SettleSheet
        visible={settleOpen}
        customer={p}
        onClose={() => setSettleOpen(false)}
        onSettled={(text) => {
          setSettleOpen(false);
          setMessage({ kind: "success", text });
          void load();
        }}
      />
    </Screen>
  );
}

function SettleSheet({
  visible,
  customer,
  onClose,
  onSettled,
}: {
  visible: boolean;
  customer: CustomerProfile;
  onClose: () => void;
  onSettled: (message: string) => void;
}) {
  const balance = customer.customer.khataBalance;
  const [amountText, setAmountText] = useState("");
  const [mode, setMode] = useState<SettleMode>("CASH");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setAmountText((balance / 100).toString());
    setMode("CASH");
    setNote("");
    setError(null);
  }, [visible, balance]);

  const amount = parseRupees(amountText);
  const valid = amount != null && amount > 0 && amount <= balance;

  const submit = async () => {
    if (!valid || amount == null) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.settleKhata(customer.customer.id, { amount, mode, note: note.trim() || undefined });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSettled(`${inr(amount)} received by ${humanize(mode)}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Settle khata">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <AppText variant="muted">Outstanding {inr(balance)}</AppText>
        <Input label="Amount received (₹)" value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad" style={{ fontSize: 26, fontWeight: "800" }} />
        <Row style={{ flexWrap: "wrap" }}>
          <Chip label="Full" selected={amount === balance} onPress={() => setAmountText((balance / 100).toString())} />
          <Chip label="Half" onPress={() => setAmountText((Math.round(balance / 2) / 100).toString())} />
        </Row>
        <Row style={{ flexWrap: "wrap" }}>
          {KHATA_SETTLE_MODES.map((m) => (
            <Chip key={m} label={humanize(m)} selected={mode === m} onPress={() => setMode(m)} />
          ))}
        </Row>
        <Input placeholder="Note (optional)" value={note} onChangeText={setNote} maxLength={200} />
        {amount != null && amount > balance ? <Notice kind="error" message="More than the outstanding amount." /> : null}
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title={valid && amount ? `Record ${inr(amount)}` : "Record payment"} icon="checkmark" size="xl" variant="success" disabled={!valid} loading={busy} onPress={submit} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  kpis: { flexDirection: "row", gap: space.md },
});

export default withAccess(["customer:view"], CustomerDetail);
