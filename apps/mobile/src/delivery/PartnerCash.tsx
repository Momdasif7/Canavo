import React, { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button, Card, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { formatTime, inr } from "../lib/format";
import { useSocketEvent } from "../lib/socket";
import type { PartnerCash } from "../lib/types";
import { radius, space, TAP, useTheme } from "../theme";
import { RecordHandoverSheet, type HandoverTarget } from "./RecordHandoverSheet";

/**
 * Manager (delivery:manage) on the delivery board: cash each partner holds
 * (collected at the door − handovers), today's collected / received, the
 * pending orders, and "Record cash received".
 */
export function PartnerCashList({ outletId }: { outletId: string | null }) {
  const t = useTheme();
  const [rows, setRows] = useState<PartnerCash[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState<HandoverTarget | null>(null);
  const [done, setDone] = useState<{ message: string; warnings?: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await endpoints.partnerCash());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    setRows(null);
    void load();
  }, [load, outletId]);
  useSocketEvent("delivery:updated", () => void load());

  const total = (rows ?? []).reduce((s, r) => s + Math.max(0, r.balance), 0);
  if (!rows && !error) return null;
  const sorted = [...(rows ?? [])].sort((a, b) => b.balance - a.balance);

  return (
    <Card style={{ gap: space.sm }}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row style={{ gap: 6 }}>
          <Ionicons name="wallet-outline" size={22} color={t.primary} />
          <AppText variant="h3">Cash with partners</AppText>
        </Row>
        <AppText variant="price">{inr(total)}</AppText>
      </Row>
      {error ? <Notice kind="error" message={error} /> : null}
      {done ? <Notice kind="success" message={done.message} /> : null}
      {done?.warnings?.map((w) => <Notice key={w} kind="warning" message={w} />)}
      {rows && rows.length === 0 ? <AppText variant="muted">No delivery partners in this outlet.</AppText> : null}
      {sorted.map((r) => {
        const expanded = open === r.agent.id;
        const holds = r.balance > 0;
        return (
          <View key={r.agent.id} style={[styles.row, { borderColor: t.border }]}>
            <Pressable
              onPress={() => setOpen(expanded ? null : r.agent.id)}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`${r.agent.name}, ${inr(r.balance)} to receive`}
              style={styles.head}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontWeight: "800" }}>{r.agent.name}</AppText>
                <AppText variant="small">
                  Today: collected {inr(r.collectedToday)} · received {inr(r.receivedToday)}
                </AppText>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <AppText variant="small">To receive</AppText>
                <AppText variant="price" color={holds ? t.warning : t.success}>
                  {inr(r.balance)}
                </AppText>
              </View>
              <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={20} color={t.textMuted} />
            </Pressable>
            {expanded ? (
              <View style={{ gap: 4, paddingBottom: space.sm }}>
                {r.pending.length === 0 ? <AppText variant="small">No pending orders.</AppText> : null}
                {r.pending.map((d, i) => (
                  <Row key={`${d.orderId}-${i}`} style={{ justifyContent: "space-between" }}>
                    <AppText variant="small" style={{ flex: 1 }} numberOfLines={1}>
                      {d.invoiceNumber} · {d.customerName ?? "—"}
                      {d.collectedAt ? ` · ${formatTime(d.collectedAt)}` : ""}
                    </AppText>
                    <AppText variant="small" style={{ fontWeight: "700" }}>
                      {inr(d.amount)}
                    </AppText>
                  </Row>
                ))}
                {r.lastHandoverAt ? <AppText variant="small">Last handover {formatTime(r.lastHandoverAt)}</AppText> : null}
                <Button
                  title="Activity & handovers"
                  icon="stats-chart-outline"
                  variant="ghost"
                  size="md"
                  onPress={() => router.push({ pathname: "/delivery-partners/[agentId]", params: { agentId: r.agent.id, name: r.agent.name } })}
                />
              </View>
            ) : null}
            <Row style={{ paddingBottom: space.sm }}>
              <Pressable
                onPress={() => void Linking.openURL(`tel:${r.agent.phone}`)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${r.agent.name}`}
                style={[styles.call, { borderColor: t.border }]}
              >
                <Ionicons name="call" size={20} color={t.primary} />
              </Pressable>
              <Button
                title="Record cash received"
                icon="cash-outline"
                variant={holds ? "success" : "secondary"}
                size="md"
                style={{ flex: 1 }}
                onPress={() => {
                  setDone(null);
                  setRecording({ agent: r.agent, balance: r.balance });
                }}
              />
            </Row>
          </View>
        );
      })}
      <RecordHandoverSheet
        target={recording}
        onClose={() => setRecording(null)}
        onSaved={(message, warnings) => {
          setRecording(null);
          setDone({ message, warnings });
          void load();
        }}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { borderTopWidth: StyleSheet.hairlineWidth, gap: space.xs },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP },
  call: { width: TAP - 4, height: TAP - 4, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
