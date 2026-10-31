import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, EmptyState, ErrorState, Loading, Notice, Row, Segmented } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { formatDate, inr } from "../../src/lib/format";
import type { PurchaseDetail, PurchaseRow } from "../../src/lib/types";
import { fmtQty } from "../../src/inventory/StockActionSheet";
import { radius, space, TAP, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

type Tab = "DRAFT" | "RECEIVED";

/** Receive pending (draft) purchases into stock. Purchases are created on the web dashboard. */
function Purchases() {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>("DRAFT");
  const [list, setList] = useState<PurchaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, PurchaseDetail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await endpoints.purchases(tab));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [tab]);

  useEffect(() => {
    setList(null);
    setOpen(null);
    void load();
  }, [load]);

  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!detail[id]) {
      try {
        const d = await endpoints.purchase(id);
        setDetail((cur) => ({ ...cur, [id]: d }));
      } catch (e) {
        setMessage({ kind: "error", text: errorMessage(e) });
      }
    }
  };

  const receive = (p: PurchaseRow) =>
    Alert.alert("Receive this purchase?", `${p.vendor.name} · ${inr(p.total)}\nStock is added for every line and average cost is updated.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Receive stock",
        onPress: async () => {
          setBusy(p.id);
          setMessage(null);
          try {
            await endpoints.receivePurchase(p.id);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setMessage({ kind: "success", text: `Received ${p.invoiceNo ?? "purchase"} from ${p.vendor.name}.` });
            await load();
          } catch (e) {
            setMessage({ kind: "error", text: errorMessage(e) });
          } finally {
            setBusy(null);
          }
        },
      },
    ]);

  return (
    <Screen
      edges={[]}
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <Segmented
        options={[
          { value: "DRAFT", label: "To receive" },
          { value: "RECEIVED", label: "Received" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {message ? <Notice kind={message.kind} message={message.text} /> : null}
      {!list && error ? <ErrorState message={error} onRetry={load} /> : null}
      {!list && !error ? (
        <View style={{ height: 200 }}>
          <Loading />
        </View>
      ) : null}
      {list && list.length === 0 ? (
        <View style={{ height: 240 }}>
          <EmptyState
            icon="cube-outline"
            title={tab === "DRAFT" ? "Nothing waiting" : "No received purchases"}
            message={tab === "DRAFT" ? "Draft purchases created on the dashboard appear here for receiving." : undefined}
          />
        </View>
      ) : null}
      {list?.map((p) => {
        const d = detail[p.id];
        const expanded = open === p.id;
        return (
          <Card key={p.id} style={{ gap: space.sm }}>
            <Pressable onPress={() => toggle(p.id)} accessibilityRole="button" accessibilityState={{ expanded }} style={styles.head}>
              <View style={{ flex: 1 }}>
                <AppText variant="h3">{p.vendor.name}</AppText>
                <AppText variant="small">
                  {p.invoiceNo ? `Inv ${p.invoiceNo} · ` : ""}
                  {formatDate(p.invoiceDate ?? p.createdAt)} · {p._count?.items ?? d?.items.length ?? "?"} lines
                </AppText>
              </View>
              <AppText variant="price">{inr(p.total)}</AppText>
              <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={22} color={t.textMuted} />
            </Pressable>
            {expanded ? (
              d ? (
                <View style={{ gap: 6 }}>
                  {d.items.map((i) => (
                    <Row key={i.id} style={{ justifyContent: "space-between" }}>
                      <AppText style={{ flex: 1 }} numberOfLines={1}>
                        {i.item?.name ?? "Item"}
                      </AppText>
                      <AppText variant="muted">
                        {fmtQty(i.quantity)} {i.item?.unit ?? ""} × {inr(i.unitCost)}
                      </AppText>
                    </Row>
                  ))}
                  {d.notes ? <AppText variant="small">Note: {d.notes}</AppText> : null}
                </View>
              ) : (
                <Loading />
              )
            ) : null}
            {p.status === "DRAFT" ? (
              <Button title="Receive stock" icon="download-outline" variant="success" size="lg" loading={busy === p.id} onPress={() => receive(p)} />
            ) : p.balance > 0 ? (
              <AppText variant="small" color={t.warning}>
                {inr(p.balance)} unpaid to vendor
              </AppText>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP, borderRadius: radius.md },
});

export default withAccess(["inventory:view"], Purchases);
