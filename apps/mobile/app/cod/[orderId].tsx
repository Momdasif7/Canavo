import React, { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { useSignedIn } from "../../src/auth/AuthContext";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Notice } from "../../src/components/ui";
import { api, endpoints, errorMessage } from "../../src/lib/api";
import { inr } from "../../src/lib/format";
import type { Order, Receipt } from "../../src/lib/types";
import { codDue, isCod, partnerLabel } from "../../src/pos/cod";
import { AssignStatus } from "../../src/delivery/AssignStatus";
import { documentLabel, gstSafeReceipt } from "../../src/pos/localBill";
import { getPrinterPrefs, printReceipt, receiptText } from "../../src/printing";
import { font, radius, space, useTheme } from "../../src/theme";

type Busy = null | "print" | "pdf" | "undo";

/**
 * Cash on Delivery placed: nothing was paid. Shows what the partner collects,
 * lets the cashier print / share the unpaid bill (it carries a "CASH ON
 * DELIVERY — amount to pay" line), and start a new bill.
 */
function CodPlaced() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const t = useTheme();
  const { allowed } = useSignedIn();
  const canBills = allowed("bills:view");
  const [order, setOrder] = useState<Order | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [paper, setPaper] = useState<58 | 80>(58);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const [o, prefs] = await Promise.all([endpoints.getOrder(orderId), getPrinterPrefs()]);
      setOrder(o);
      setPaper(prefs.paper);
      // The bill needs `bills:view`; the COD itself doesn't.
      if (canBills) setReceipt(gstSafeReceipt(await endpoints.receipt(orderId)));
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e, "Could not load the order") });
    }
  }, [orderId, canBills]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<string | void>) => {
    setBusy(kind);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "success", text });
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(null);
    }
  };

  const print = () =>
    run("print", async () => {
      if (!receipt) return;
      const via = await printReceipt(receipt);
      return via === "bluetooth" ? "Unpaid bill sent to the thermal printer." : undefined;
    });

  const sharePdf = () =>
    run("pdf", async () => {
      if (!orderId || !receipt) return;
      const uri = await api.download(`/orders/${orderId}/receipt.pdf`, `${receipt.invoiceNumber}.pdf`);
      if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is not available on this device");
      await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: `${documentLabel(receipt.documentType)} ${receipt.invoiceNumber}` });
    });

  /** The customer wants to pay at the counter after all. */
  const undo = () =>
    Alert.alert("Collect payment now?", "This removes Cash on Delivery from the order and opens the payment screen.", [
      { text: "Keep COD", style: "cancel" },
      {
        text: "Collect now",
        onPress: () =>
          void run("undo", async () => {
            if (!orderId) return;
            await endpoints.markCod(orderId, false);
            router.replace({ pathname: "/payment/[orderId]", params: { orderId } });
          }),
      },
    ]);

  const amount = order ? codDue(order) : null;
  const partner = order?.delivery?.agent?.name ?? null;
  const cod = isCod(order);
  const paid = order?.status === "PAID";
  const preview = receipt ? receiptText(receipt, paper) : [];

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={[styles.icon, { backgroundColor: paid ? t.success : t.warning }]}>
          <Ionicons name={paid ? "checkmark" : "bicycle"} size={52} color="#fff" />
        </View>
        <AppText variant="h2" style={{ textAlign: "center" }}>
          {paid ? "Order already paid" : "COD order placed"}
        </AppText>
        {order ? (
          <AppText variant="muted">
            {order.invoiceNumber}
            {order.customerName ? ` · ${order.customerName}` : ""}
          </AppText>
        ) : null}
      </View>

      {order && !paid ? (
        <View style={[styles.collect, { backgroundColor: t.warningBg, borderColor: t.warning }]} accessibilityRole="summary">
          <AppText style={{ fontWeight: "900", fontSize: font.lg }} color={t.warning}>
            COD · Collect cash
          </AppText>
          <AppText variant="priceLg" color={t.warning}>
            {inr(amount ?? 0)}
          </AppText>
          <AppText color={t.warning} style={{ fontWeight: "600", textAlign: "center" }}>
            No payment now — {partner ? `${partnerLabel(partner)} collects it` : "the delivery partner collects it"} in cash at the door.
          </AppText>
        </View>
      ) : null}

      {order && !paid ? <AssignStatus order={order} /> : null}
      {order && !cod && !paid ? <Notice kind="warning" message="This order is not marked COD." /> : null}
      {message ? <Notice kind={message.kind} message={message.text} /> : null}

      <View style={styles.actions}>
        <Button title="Print bill" icon="print-outline" variant="secondary" loading={busy === "print"} disabled={!receipt || !!busy} onPress={print} style={styles.action} />
        <Button title="Share PDF" icon="document-outline" variant="secondary" loading={busy === "pdf"} disabled={!receipt || !!busy} onPress={sharePdf} style={styles.action} />
      </View>
      <Button title="New bill" icon="add-circle-outline" size="xl" onPress={() => router.replace("/(tabs)/bill")} />
      {cod && !paid && order?.status === "OPEN" ? (
        <Button title="Customer pays now instead" icon="arrow-undo-outline" variant="ghost" size="md" loading={busy === "undo"} disabled={!!busy} onPress={undo} />
      ) : null}

      {preview.length ? (
        <Card style={{ padding: space.md }}>
          <AppText variant="small" style={{ marginBottom: space.xs }}>
            Unpaid bill — shows the amount to pay on delivery
          </AppText>
          <ScrollView horizontal>
            <AppText style={[styles.mono, { color: t.text }]}>{preview.join("\n")}</AppText>
          </ScrollView>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.xs, paddingTop: space.lg },
  icon: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  collect: { borderRadius: radius.lg, borderWidth: 2, padding: space.lg, alignItems: "center", gap: space.xs },
  actions: { flexDirection: "row", gap: space.md },
  action: { flex: 1 },
  mono: { fontFamily: "monospace", fontSize: 11, lineHeight: 15 },
});

/** Same permission as POST /orders/:id/cod. */
export default withAccess(["payment:collect"], CodPlaced);
