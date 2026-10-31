import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Chip, Input, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { formatTime, inr } from "../lib/format";
import type { CashHandover, StaffRef } from "../lib/types";
import { font, space, useTheme } from "../theme";
import { parseHandoverAmount, rupeesText } from "./portal";

export interface HandoverTarget {
  agent: StaffRef;
  /** Cash the partner holds now (paise) */
  balance: number;
  /** Set → edit this entry instead of recording a new one */
  handover?: CashHandover;
}

/**
 * Manager: "Record cash received" from a delivery partner (any amount — partial
 * handovers are fine), or correct an earlier entry.
 */
export function RecordHandoverSheet({
  target,
  onClose,
  onSaved,
}: {
  target: HandoverTarget | null;
  onClose: () => void;
  onSaved: (message: string, warnings?: string[]) => void;
}) {
  const t = useTheme();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setAmount(rupeesText(target.handover ? target.handover.amount : target.balance));
    setNote(target.handover?.note ?? "");
    setError(null);
  }, [target]);

  if (!target) return null;
  const editing = target.handover;
  const paise = parseHandoverAmount(amount);
  // After this entry, what the partner would still hold.
  const after = paise == null ? null : editing ? target.balance + editing.amount - paise : target.balance - paise;

  const save = async () => {
    if (paise == null) return setError("Enter the amount received");
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const res = editing
        ? await endpoints.updateHandover(editing.id, { amount: paise, note: trimmed || null })
        : await endpoints.recordHandover({ agentId: target.agent.id, amount: paise, ...(trimmed && { note: trimmed }) });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSaved(
        editing
          ? `Handover updated · ${target.agent.name} now holds ${inr(Math.max(0, res.balance))}`
          : `${inr(paise)} received from ${target.agent.name} · ${res.balance > 0 ? `${inr(res.balance)} still to receive` : "all settled"}`,
        res.warnings,
      );
    } catch (e) {
      setError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!target} onClose={onClose} title={editing ? "Edit handover" : "Record cash received"}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 2 }}>
          <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{target.agent.name}</AppText>
          <AppText variant="muted">
            {editing
              ? `Recorded ${formatTime(editing.receivedAt)}${editing.receivedBy ? ` by ${editing.receivedBy.name}` : ""} · ${inr(editing.amount)}`
              : `Holds ${inr(Math.max(0, target.balance))} in cash right now. Count the cash before saving.`}
          </AppText>
        </View>
        <Input
          label="Amount received (₹)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
          autoFocus={!editing}
          style={{ fontSize: font.xxl, fontWeight: "900", minHeight: 64 }}
          accessibilityLabel="Amount received in rupees"
        />
        {!editing && target.balance > 0 ? (
          <Row style={{ flexWrap: "wrap" }}>
            <Chip label={`Full ${inr(target.balance)}`} selected={paise === target.balance} onPress={() => setAmount(rupeesText(target.balance))} />
          </Row>
        ) : null}
        {after != null ? (
          <AppText variant="small" color={after < 0 ? t.danger : after === 0 ? t.success : t.textMuted} style={{ fontWeight: "700" }}>
            {after > 0 ? `${inr(after)} will still be with the partner` : after === 0 ? "Fully settled after this" : `${inr(-after)} more than they hold`}
          </AppText>
        ) : null}
        <Input label="Note (optional)" value={note} onChangeText={setNote} maxLength={300} placeholder="e.g. Partial, rest tomorrow" />
        {error ? <Notice kind="error" message={error} /> : null}
        <Button
          title={editing ? "Save changes" : paise ? `Record ${inr(paise)} received` : "Record cash received"}
          icon="checkmark-done"
          variant="success"
          size="xl"
          disabled={paise == null}
          loading={busy}
          onPress={save}
        />
        <Button title="Cancel" variant="ghost" onPress={onClose} />
      </ScrollView>
    </Sheet>
  );
}
