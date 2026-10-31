import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../src/components/Screen";
import { AppText, Button, Notice } from "../src/components/ui";
import { errorMessage } from "../src/lib/api";
import { inr } from "../src/lib/format";
import { useOffline } from "../src/offline/OfflineContext";
import { noTaxNote } from "../src/pos/localBill";
import { getLastOfflineReceipt } from "../src/pos/offlineReceipt";
import { getPrinterPrefs, printLines, receiptText } from "../src/printing";
import { space, useTheme } from "../src/theme";

export default function OfflineSaved() {
  const { total, mode } = useLocalSearchParams<{ total: string; mode: string }>();
  const t = useTheme();
  const { pendingCount, online } = useOffline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = getLastOfflineReceipt();

  const print = async () => {
    if (!receipt) return;
    setBusy(true);
    setError(null);
    try {
      const prefs = await getPrinterPrefs();
      await printLines(receiptText(receipt, prefs.paper));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={[styles.icon, { backgroundColor: t.warning }]}>
          <Ionicons name="cloud-offline" size={48} color="#fff" />
        </View>
        <AppText variant="h2">Bill saved on this phone</AppText>
        <AppText variant="priceLg">{inr(Number(total ?? 0))}</AppText>
        <AppText variant="muted">Paid by {mode === "CARD" ? "card" : "cash"}</AppText>
        {receipt && noTaxNote(receipt.documentType) ? <AppText variant="small">{noTaxNote(receipt.documentType)}</AppText> : null}
      </View>
      <Notice
        kind="info"
        message={`${pendingCount} bill${pendingCount === 1 ? "" : "s"} waiting to sync. ${
          online ? "Syncing now." : "They will upload automatically when you're back online."
        } The kitchen gets the order (KOT) once it syncs — tell the kitchen directly if it's urgent. The final bill number is assigned on sync.`}
      />
      {error ? <Notice kind="error" message={error} /> : null}
      <Button title="Print provisional bill" icon="print-outline" variant="secondary" loading={busy} disabled={!receipt} onPress={print} />
      <Button title="New bill" icon="add-circle-outline" size="xl" onPress={() => router.replace("/(tabs)/bill")} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.xs, paddingTop: space.xl },
  icon: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
});
