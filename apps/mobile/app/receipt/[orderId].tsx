import React, { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Sharing from "expo-sharing";
import { receiptTaxLines } from "@canavo/shared";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, Card, Input, Notice } from "../../src/components/ui";
import { api, endpoints, errorMessage } from "../../src/lib/api";
import { inr } from "../../src/lib/format";
import type { Receipt } from "../../src/lib/types";
import { getPrinterPrefs, printReceipt, receiptText } from "../../src/printing";
import { documentLabel, gstSafeReceipt, noTaxNote } from "../../src/pos/localBill";
import { radius, space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

type Busy = null | "print" | "pdf" | "wa";

function ReceiptScreen() {
  const { orderId, change, sessionId } = useLocalSearchParams<{ orderId: string; change?: string; sessionId?: string }>();
  const t = useTheme();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [paper, setPaper] = useState<58 | 80>(58);
  const [customerPhone, setCustomerPhone] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  const [waOpen, setWaOpen] = useState(false);
  const changeDue = Number(change ?? 0);

  const load = useCallback(async () => {
    if (!orderId) return;
    try {
      const [r, prefs, order] = await Promise.all([endpoints.receipt(orderId), getPrinterPrefs(), endpoints.getOrder(orderId)]);
      setReceipt(gstSafeReceipt(r));
      setPaper(prefs.paper);
      if (order.customerPhone) setCustomerPhone(order.customerPhone);
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e, "Could not load the receipt") });
    }
  }, [orderId]);

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
    } finally {
      setBusy(null);
    }
  };

  const print = () =>
    run("print", async () => {
      if (!receipt) return;
      const via = await printReceipt(receipt);
      return via === "bluetooth" ? "Sent to the thermal printer." : undefined;
    });

  const sharePdf = () =>
    run("pdf", async () => {
      if (!orderId || !receipt) return;
      const uri = await api.download(`/orders/${orderId}/receipt.pdf`, `${receipt.invoiceNumber}.pdf`);
      if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is not available on this device");
      await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: `${documentLabel(receipt.documentType)} ${receipt.invoiceNumber}` });
    });

  const shareWhatsApp = () =>
    run("wa", async () => {
      if (!orderId) return;
      if (!/^[6-9]\d{9}$/.test(customerPhone)) throw new Error("Enter a valid 10-digit mobile number");
      const res = await endpoints.shareWhatsApp(orderId, customerPhone);
      setWaOpen(false);
      if (res.method === "sent") return `Sent on WhatsApp to ${customerPhone}.`;
      // No provider (or it failed): open the chat with the bill link filled in.
      await Linking.openURL(res.waLink);
      if (res.error) setMessage({ kind: "info", text: res.error });
    });

  const newBill = () => router.replace("/(tabs)/bill");
  const preview = receipt ? receiptText(receipt, paper) : [];
  // CGST/SGST (or IGST), cess and extra taxes by label; empty for a BILL / bill of supply.
  const taxLines = receipt && receipt.documentType === "TAX_INVOICE" ? receiptTaxLines(receipt).filter((l) => l.amount) : [];
  const taxNote = receipt ? noTaxNote(receipt.documentType, receipt.gstEnabled) : null;

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={[styles.tick, { backgroundColor: t.success }]}>
          <Ionicons name="checkmark" size={56} color="#fff" />
        </View>
        <AppText variant="h2">Payment received</AppText>
        {receipt ? (
          <>
            <AppText variant="priceLg">{inr(receipt.grandTotal)}</AppText>
            <AppText variant="muted">
              {documentLabel(receipt.documentType)} {receipt.invoiceNumber}
            </AppText>
            {taxLines.length ? (
              <AppText variant="small" style={{ textAlign: "center" }}>
                Incl. {taxLines.map((l) => `${l.label} ${inr(l.amount)}`).join(" · ")}
              </AppText>
            ) : taxNote ? (
              <AppText variant="small" style={{ textAlign: "center" }}>
                {taxNote}
              </AppText>
            ) : null}
          </>
        ) : null}
        {changeDue > 0 ? (
          <View style={[styles.change, { backgroundColor: t.successBg }]}>
            <AppText variant="h3" color={t.success}>
              Return change {inr(changeDue)}
            </AppText>
          </View>
        ) : null}
      </View>

      {message ? <Notice kind={message.kind} message={message.text} /> : null}

      <View style={styles.actions}>
        <Button title="Print" icon="print-outline" variant="secondary" loading={busy === "print"} disabled={!receipt || !!busy} onPress={print} style={styles.action} />
        <Button title="Share PDF" icon="document-outline" variant="secondary" loading={busy === "pdf"} disabled={!receipt || !!busy} onPress={sharePdf} style={styles.action} />
      </View>
      <Button title="WhatsApp bill" icon="logo-whatsapp" variant="secondary" disabled={!receipt || !!busy} onPress={() => setWaOpen(true)} />
      {sessionId ? (
        // Payment replaced itself with this screen, so the table tab is right behind us.
        <Button title="Back to table" icon="grid-outline" size="xl" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/tables"))} />
      ) : (
        <Button title="New bill" icon="add-circle-outline" size="xl" onPress={newBill} />
      )}

      {preview.length ? (
        <Card style={{ padding: space.md }}>
          <ScrollView horizontal>
            <AppText style={[styles.mono, { color: t.text }]}>{preview.join("\n")}</AppText>
          </ScrollView>
        </Card>
      ) : null}

      <Sheet visible={waOpen} onClose={() => setWaOpen(false)} title="Send bill on WhatsApp">
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <Input
            label="Customer mobile"
            value={customerPhone}
            onChangeText={(v) => setCustomerPhone(v.replace(/\D/g, "").slice(0, 10))}
            keyboardType="phone-pad"
            maxLength={10}
            autoFocus
          />
          <Button title="Send" icon="logo-whatsapp" variant="success" loading={busy === "wa"} onPress={shareWhatsApp} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.xs, paddingTop: space.lg },
  tick: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  change: { marginTop: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.md },
  actions: { flexDirection: "row", gap: space.md },
  action: { flex: 1 },
  mono: { fontFamily: "monospace", fontSize: 11, lineHeight: 15 },
});

/** Bills / receipts: owner, manager and cashier only (`bills:view`). */
export default withAccess(["bills:view"], ReceiptScreen);
