import React from "react";
import { Modal, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button } from "../components/ui";
import { inr } from "../lib/format";
import type { Delivery } from "../lib/types";
import { space, useTheme } from "../theme";

export interface DeliveredResult {
  delivery: Delivery;
  /** Cash the partner collected at the door (0 = already paid) */
  cashCollected: number;
}

/** Full-screen "Delivered" confirmation after the one-tap complete. */
export function DeliveredModal({
  result,
  remaining,
  onDone,
  onViewCash,
}: {
  result: DeliveredResult | null;
  remaining: number;
  onDone: () => void;
  onViewCash?: () => void;
}) {
  const t = useTheme();
  if (!result) return null;
  const d = result.delivery;
  const cash = result.cashCollected > 0;
  return (
    <Modal visible animationType="fade" onRequestClose={onDone} statusBarTranslucent>
      <SafeAreaView style={[styles.root, { backgroundColor: t.success }]}>
        <View style={styles.center}>
          <View style={styles.circle}>
            <Ionicons name="checkmark" size={88} color={t.success} />
          </View>
          <AppText style={styles.big}>Delivered!</AppText>
          <AppText style={styles.text}>
            {d.order.invoiceNumber} · {d.customerName}
          </AppText>
          {cash ? (
            <>
              <AppText style={[styles.text, { fontWeight: "900", fontSize: 26 }]}>{inr(result.cashCollected)} cash collected</AppText>
              <AppText style={styles.text}>Added to your cash to hand over. Keep it safe and give it to the cashier or manager.</AppText>
            </>
          ) : (
            <AppText style={[styles.text, { fontWeight: "800" }]}>Already paid · nothing collected</AppText>
          )}
        </View>
        <View style={{ padding: space.lg, gap: space.sm }}>
          <Button
            title={remaining ? `Next delivery (${remaining} left)` : "Done"}
            icon={remaining ? "arrow-forward" : "checkmark-done"}
            variant="secondary"
            size="xl"
            onPress={onDone}
          />
          {cash && onViewCash ? (
            <Button title="See cash to hand over" icon="wallet-outline" variant="secondary" size="lg" onPress={onViewCash} />
          ) : null}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl },
  circle: { width: 150, height: 150, borderRadius: 75, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  big: { color: "#fff", fontSize: 40, fontWeight: "900" },
  text: { color: "#fff", fontSize: 18, textAlign: "center" },
});
