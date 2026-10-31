import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Chip, Input, Notice, Row, Segmented } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { inr } from "../lib/format";
import type { InventoryItem } from "../lib/types";
import { radius, space, useTheme } from "../theme";

type Mode = "ADD" | "REMOVE" | "SET" | "WASTE";

const REASONS: Record<Mode, string[]> = {
  ADD: ["Received without bill", "Count correction", "Returned to stock"],
  REMOVE: ["Count correction", "Used for staff meal", "Sent to other outlet"],
  SET: ["Physical count"],
  WASTE: ["Spoiled", "Expired", "Spilled / damaged", "Burnt / rejected"],
};

export function fmtQty(q: number) {
  return Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** Item detail with quick stock adjustment and wastage entry (inventory:manage). */
export function StockActionSheet({
  item,
  canManage,
  onClose,
  onDone,
}: {
  item: InventoryItem | null;
  canManage: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useTheme();
  const [mode, setMode] = useState<Mode>("WASTE");
  const [qtyText, setQtyText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode("WASTE");
    setQtyText("");
    setReason("");
    setError(null);
  }, [item]);

  if (!item) return null;
  const qty = Number(qtyText.replace(",", "."));
  const validQty = Number.isFinite(qty) && (mode === "SET" ? qty >= 0 && qtyText !== "" : qty > 0);
  const after = !validQty ? null : mode === "ADD" ? item.quantity + qty : mode === "SET" ? qty : item.quantity - qty;

  const submit = async () => {
    if (!validQty || reason.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "WASTE") {
        const res = await endpoints.wastage([{ inventoryItemId: item.id, quantity: qty, reason: reason.trim() }]);
        onDone(`Wastage recorded: ${fmtQty(qty)} ${item.unit} of ${item.name} (${inr(res.value)})`);
      } else if (mode === "SET") {
        await endpoints.adjustStock(item.id, { setTo: qty, reason: reason.trim() });
        onDone(`${item.name} set to ${fmtQty(qty)} ${item.unit}`);
      } else {
        await endpoints.adjustStock(item.id, { quantity: mode === "ADD" ? qty : -qty, reason: reason.trim() });
        onDone(`${item.name} ${mode === "ADD" ? "+" : "−"}${fmtQty(qty)} ${item.unit}`);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!item} onClose={onClose} title={item.name} maxHeight="92%">
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <View style={[styles.stock, { backgroundColor: item.lowStock ? (item.quantity <= 0 ? t.dangerBg : t.warningBg) : t.surfaceAlt }]}>
          <View style={{ flex: 1 }}>
            <AppText variant="small">In stock</AppText>
            <AppText variant="priceLg" style={{ fontSize: 34 }} color={item.lowStock ? (item.quantity <= 0 ? t.danger : t.warning) : t.text}>
              {fmtQty(item.quantity)} <AppText variant="h3">{item.unit}</AppText>
            </AppText>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <AppText variant="small">Reorder at {fmtQty(item.reorderLevel)}</AppText>
            <AppText variant="small">{item.category}</AppText>
            {item.barcode || item.sku ? <AppText variant="small">{item.sku ?? item.barcode}</AppText> : null}
          </View>
        </View>

        {canManage ? (
          <>
            <Segmented
              options={[
                { value: "WASTE", label: "Wastage" },
                { value: "ADD", label: "Add" },
                { value: "REMOVE", label: "Remove" },
                { value: "SET", label: "Set to" },
              ]}
              value={mode}
              onChange={(m) => {
                setMode(m);
                setReason("");
              }}
            />
            <Input
              label={`${mode === "SET" ? "New quantity" : "Quantity"} (${item.unit})`}
              value={qtyText}
              onChangeText={(v) => setQtyText(v.replace(/[^\d.,]/g, ""))}
              keyboardType="decimal-pad"
              placeholder="0"
              style={{ fontSize: 28, fontWeight: "800", minHeight: 64, textAlign: "center" }}
              autoFocus
            />
            {after != null ? (
              <AppText variant="small" color={after < 0 ? t.danger : t.textMuted} style={{ textAlign: "center" }}>
                After: {fmtQty(Math.round(after * 1000) / 1000)} {item.unit}
              </AppText>
            ) : null}
            <Row style={{ flexWrap: "wrap" }}>
              {REASONS[mode].map((r) => (
                <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(r)} />
              ))}
            </Row>
            <Input placeholder="Reason" value={reason} onChangeText={setReason} maxLength={200} />
            {error ? <Notice kind="error" message={error} /> : null}
            <Button
              title={mode === "WASTE" ? "Record wastage" : "Save adjustment"}
              icon={mode === "WASTE" ? "trash-bin-outline" : "save-outline"}
              size="xl"
              variant={mode === "WASTE" ? "danger" : "primary"}
              disabled={!validQty || reason.trim().length < 2}
              loading={busy}
              onPress={submit}
            />
          </>
        ) : (
          <Notice kind="info" message="You can view stock. Adjustments and wastage need inventory manager access." />
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stock: { flexDirection: "row", alignItems: "center", borderRadius: radius.md, padding: space.md, gap: space.md },
});
