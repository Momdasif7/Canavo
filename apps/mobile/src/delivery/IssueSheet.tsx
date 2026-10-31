import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Input, Notice } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import type { Delivery, DeliveryIssueReason } from "../lib/types";
import { radius, space, TAP, useTheme } from "../theme";
import { ISSUE_REASONS } from "./portal";

/** "Report a problem": the outlet's managers get notified and decide what to do. */
export function IssueSheet({ delivery, onClose, onReported }: { delivery: Delivery | null; onClose: () => void; onReported: (d: Delivery) => void }) {
  const t = useTheme();
  const [reason, setReason] = useState<DeliveryIssueReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason(null);
    setNote("");
    setError(null);
  }, [delivery]);

  if (!delivery) return null;
  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const d = await endpoints.reportDeliveryIssue(delivery.id, reason, note.trim() || undefined);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onReported(d);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!delivery} onClose={onClose} title="Report a problem">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <AppText variant="muted">
          {delivery.order.invoiceNumber} · {delivery.customerName}. The outlet is notified right away.
        </AppText>
        {ISSUE_REASONS.map((r) => {
          const active = reason === r.value;
          return (
            <Pressable
              key={r.value}
              onPress={() => {
                void Haptics.selectionAsync();
                setReason(r.value);
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              style={[styles.option, { borderColor: active ? t.danger : t.border, backgroundColor: active ? t.dangerBg : t.surface }]}
            >
              <Ionicons name={r.icon as keyof typeof Ionicons.glyphMap} size={22} color={active ? t.danger : t.textMuted} />
              <AppText style={{ flex: 1, fontWeight: "700" }}>{r.label}</AppText>
              <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={22} color={active ? t.danger : t.textMuted} />
            </Pressable>
          );
        })}
        <View style={{ marginTop: space.sm }}>
          <Input label="Details (optional)" value={note} onChangeText={setNote} maxLength={300} multiline placeholder="e.g. Gate locked, called twice" style={{ minHeight: 80, textAlignVertical: "top", paddingTop: space.sm }} />
        </View>
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Send to outlet" icon="send" variant="danger" size="lg" disabled={!reason} loading={busy} onPress={submit} />
        <Button title="Cancel" variant="ghost" onPress={onClose} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  option: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP + 4, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md },
});
