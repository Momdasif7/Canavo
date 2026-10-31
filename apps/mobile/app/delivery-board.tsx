import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../src/auth/AuthContext";
import { Screen } from "../src/components/Screen";
import { Sheet } from "../src/components/Sheet";
import { AppText, Button, EmptyState, ErrorState, Loading, Notice, Row, Segmented } from "../src/components/ui";
import { DeliveryCard, isCodDue, nextAgentStep } from "../src/delivery/DeliveryCard";
import { PartnerCashList } from "../src/delivery/PartnerCash";
import { MarkBackButton, PartnerBadge, usePartnerAvailability } from "../src/delivery/PartnerStatus";
import { withForceConfirm } from "../src/delivery/forceAssign";
import { splitNotes } from "../src/delivery/portal";
import { endpoints, errorMessage } from "../src/lib/api";
import { inr } from "../src/lib/format";
import { useSocketEvent } from "../src/lib/socket";
import type { Delivery, DeliveryAgent } from "../src/lib/types";
import { radius, space, TAP, useTheme } from "../src/theme";
import { withAccess } from "../src/auth/RequireAccess";

type Filter = "ACTIVE" | "UNASSIGNED" | "OUT";

/** Managers / cashiers (delivery:manage): live board of active deliveries + assign agent. */
function DeliveryBoard() {
  const t = useTheme();
  const { outlet } = useSignedIn();
  const [list, setList] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [assigning, setAssigning] = useState<Delivery | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const partners = usePartnerAvailability(outlet?.id ?? null);

  const load = useCallback(async () => {
    try {
      setList(await endpoints.deliveries({ active: "1" }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setList(null);
    void load();
    const poll = setInterval(load, 30_000);
    return () => clearInterval(poll);
  }, [load, outlet?.id]);

  useSocketEvent("delivery:updated", () => void load());

  const visible = useMemo(() => {
    const all = list ?? [];
    const flagged = (d: Delivery) => (splitNotes(d.notes).issues.length ? 0 : 1);
    const sorted = [...all].sort((a, b) => flagged(a) - flagged(b));
    if (filter === "UNASSIGNED") return sorted.filter((d) => !d.agentId);
    if (filter === "OUT") return sorted.filter((d) => d.status === "OUT_FOR_DELIVERY");
    return sorted;
  }, [list, filter]);

  const cod = useMemo(() => {
    const rows = (list ?? []).filter(isCodDue);
    return { count: rows.length, amount: rows.reduce((s, d) => s + d.amountDue, 0) };
  }, [list]);

  const issueCount = useMemo(() => (list ?? []).filter((d) => splitNotes(d.notes).issues.length > 0).length, [list]);

  const advance = async (d: Delivery) => {
    const next = nextAgentStep(d.status);
    if (!next) return;
    setBusy(d.id);
    setActionError(null);
    try {
      await endpoints.deliveryStatus(d.id, next.status);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await load();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!list && error) return <Screen edges={[]} scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!list) return <Screen edges={[]} scroll={false}><Loading label="Loading deliveries…" /></Screen>;

  return (
    <Screen
      edges={[]}
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await Promise.all([load(), partners.load()]);
        setRefreshing(false);
      }}
    >
      <PartnerCashList outletId={outlet?.id ?? null} />
      <Button title="Partner activity & cash history" icon="stats-chart-outline" variant="secondary" size="md" onPress={() => router.push("/delivery-partners")} />
      {issueCount ? (
        <Notice kind="error" title={`${issueCount} deliver${issueCount === 1 ? "y has" : "ies have"} a reported problem`} message="Partner-reported issues are shown in red on the cards below. Call the customer or reassign." />
      ) : null}
      {cod.count ? (
        <View style={[styles.cod, { backgroundColor: t.warningBg, borderColor: t.warning }]} accessibilityRole="summary">
          <Ionicons name="cash" size={22} color={t.warning} />
          <AppText style={{ flex: 1, fontWeight: "800" }} color={t.warning}>
            COD · {cod.count} order{cod.count === 1 ? "" : "s"} · partners collect {inr(cod.amount)} in cash
          </AppText>
        </View>
      ) : null}
      <PartnersNow agents={partners.agents} onChanged={() => void partners.load()} />
      <Segmented
        options={[
          { value: "ACTIVE", label: `Active (${list.length})` },
          { value: "UNASSIGNED", label: `No agent (${list.filter((d) => !d.agentId).length})` },
          { value: "OUT", label: "On the way" },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {error ? <Notice kind="warning" message={`Live refresh failed: ${error}`} /> : null}
      {actionError ? <Notice kind="error" message={actionError} /> : null}
      {visible.length === 0 ? (
        <View style={{ height: 240 }}>
          <EmptyState icon="bicycle-outline" title="Nothing here" message="Delivery orders from the POS show up here." />
        </View>
      ) : (
        visible.map((d) => {
          const next = nextAgentStep(d.status);
          return (
            <DeliveryCard key={d.id} d={d}>
              {!d.agentId ? (
                <Row style={{ gap: 6 }}>
                  <Ionicons name="hourglass-outline" size={16} color={t.warning} />
                  <AppText variant="small" color={t.warning} style={{ flex: 1, fontWeight: "700" }}>
                    Waiting — auto-assigned when a partner is back
                  </AppText>
                </Row>
              ) : null}
              <Row>
                <Button
                  title={d.agentId ? "Reassign" : "Assign agent"}
                  icon="person-add-outline"
                  variant={d.agentId ? "secondary" : "primary"}
                  size="md"
                  style={{ flex: 1 }}
                  onPress={() => setAssigning(d)}
                />
                {next ? (
                  <Button
                    title={next.status === "OUT_FOR_DELIVERY" ? "Dispatch" : next.status === "DELIVERED" ? "Delivered" : "Accept"}
                    icon={next.icon}
                    size="md"
                    variant="success"
                    style={{ flex: 1 }}
                    loading={busy === d.id}
                    disabled={next.status === "OUT_FOR_DELIVERY" && !d.agentId}
                    onPress={() => advance(d)}
                  />
                ) : null}
              </Row>
            </DeliveryCard>
          );
        })
      )}
      <AssignSheet
        delivery={assigning}
        onClose={() => setAssigning(null)}
        onAssigned={() => {
          setAssigning(null);
          void load();
          void partners.load();
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
      />
      <AppText variant="small" style={{ textAlign: "center", color: t.textMuted }}>
        Live agent map is on the web dashboard.
      </AppText>
    </Screen>
  );
}

/** On-duty partners with their dispatch status; "Mark back at outlet" when GPS hasn't caught up. */
function PartnersNow({ agents, onChanged }: { agents: DeliveryAgent[] | null; onChanged: () => void }) {
  const t = useTheme();
  if (!agents?.length) return null;
  const onDuty = agents.filter((a) => a.onDuty);
  const free = onDuty.filter((a) => a.available).length;
  return (
    <View style={[styles.partners, { borderColor: t.border, backgroundColor: t.surface }]}>
      <Row style={{ justifyContent: "space-between" }}>
        <AppText variant="h3">Partners</AppText>
        <AppText variant="small">
          {free} available · {onDuty.length} on duty
        </AppText>
      </Row>
      {onDuty.length === 0 ? <AppText variant="small">No delivery partner is clocked in. New orders wait until one is back at the outlet.</AppText> : null}
      {onDuty.map((a) => (
        <View key={a.id} style={{ gap: 6 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <View style={{ flex: 1, gap: 2 }}>
              <AppText style={{ fontWeight: "800" }} numberOfLines={1}>
                {a.name}
              </AppText>
              <AppText variant="small">
                {a.active} of {a.max} orders{a.outForDelivery ? ` · ${a.outForDelivery} out` : ""}
              </AppText>
            </View>
            <PartnerBadge a={a} />
          </Row>
          <MarkBackButton a={a} onDone={onChanged} />
        </View>
      ))}
    </View>
  );
}

function AssignSheet({ delivery, onClose, onAssigned }: { delivery: Delivery | null; onClose: () => void; onAssigned: () => void }) {
  const t = useTheme();
  const [agents, setAgents] = useState<DeliveryAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!delivery) return;
    setAgents(null);
    setError(null);
    endpoints.deliveryAgents().then(setAgents).catch((e) => setError(errorMessage(e)));
  }, [delivery]);

  if (!delivery) return null;
  const assign = async (agentId: string | null) => {
    setBusy(agentId ?? "none");
    setError(null);
    try {
      // Partner at the limit / on a run → 409; managers may "Assign anyway?" (force), cashiers see why.
      const done = await withForceConfirm((force) => endpoints.assignDelivery(delivery.id, agentId, force));
      if (done) onAssigned();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet visible={!!delivery} onClose={onClose} title={`Assign ${delivery.order.invoiceNumber}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.lg }}>
        {!agents && !error ? <Loading /> : null}
        {agents?.length === 0 ? <Notice kind="warning" message="No delivery staff in this outlet." /> : null}
        {agents?.map((a) => {
          const current = delivery.agentId === a.id;
          return (
            <Pressable
              key={a.id}
              onPress={() => assign(a.id)}
              disabled={!!busy || current}
              accessibilityRole="button"
              style={({ pressed }) => [styles.agent, { borderColor: current ? t.primary : t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface }]}
            >
              <View style={[styles.dot, { backgroundColor: a.available ? t.success : a.onDuty ? t.warning : t.textMuted }]} />
              <View style={{ flex: 1, gap: 2, paddingVertical: 6 }}>
                <AppText style={{ fontWeight: "800" }}>{a.name}</AppText>
                <PartnerBadge a={a} />
                <AppText variant="small">
                  {a.active} of {a.max} orders{a.reason && !a.available ? ` · ${a.reason}` : ""}
                </AppText>
              </View>
              {busy === a.id ? <AppText variant="small">Assigning…</AppText> : current ? <Ionicons name="checkmark-circle" size={24} color={t.primary} /> : null}
            </Pressable>
          );
        })}
        {delivery.agentId ? <Button title="Unassign" variant="ghost" icon="person-remove-outline" loading={busy === "none"} onPress={() => assign(null)} /> : null}
        {error ? <Notice kind="error" message={error} /> : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  agent: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP + 8, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md },
  dot: { width: 12, height: 12, borderRadius: 6 },
  partners: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  cod: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: TAP },
});

export default withAccess(["delivery:manage"], DeliveryBoard);
