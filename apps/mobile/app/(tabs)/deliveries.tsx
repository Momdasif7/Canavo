import React, { useCallback, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../../src/auth/AuthContext";
import { withAccess } from "../../src/auth/RequireAccess";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, EmptyState, ErrorState, Loading, Notice, Row } from "../../src/components/ui";
import { DeliveredModal, type DeliveredResult } from "../../src/delivery/DeliveredModal";
import { DeliveryCard } from "../../src/delivery/DeliveryCard";
import { IssueSheet } from "../../src/delivery/IssueSheet";
import { PresenceCard, usePartnerPresence } from "../../src/delivery/PartnerPresence";
import { canComplete, completeAction, isAmountChanged, nextPartnerStep } from "../../src/delivery/portal";
import { useLiveLocation } from "../../src/delivery/useLiveLocation";
import { useMyDeliveries } from "../../src/delivery/useMyDeliveries";
import { ApiError, endpoints, errorMessage } from "../../src/lib/api";
import { formatTime } from "../../src/lib/format";
import { useSocketEvent } from "../../src/lib/socket";
import type { Delivery } from "../../src/lib/types";
import { space } from "../../src/theme";

/** Open attendance for the partner (from the summary; works without attendance permissions). */
function useOnDuty() {
  const [onDuty, setOnDuty] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    try {
      setOnDuty((await endpoints.myDeliverySummary()).onDuty);
    } catch {
      // Unknown (offline): don't nag.
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useSocketEvent("notification", () => void load());
  return { onDuty, reload: load };
}

/**
 * Delivery partner: assigned deliveries (sorted by ETA) with one big action per
 * state. No payment options: an unpaid / COD order is completed with
 * "Cash collected & delivered" (the amount due is recorded as cash the partner
 * holds), a paid one with "Delivered". Uses only /delivery/* endpoints.
 */
function MyDeliveries() {
  const { me, outlet } = useSignedIn();
  const { list, error, cachedAt, load, patch } = useMyDeliveries(me.id, outlet?.id ?? null);
  const duty = useOnDuty();
  const presence = usePartnerPresence();
  const [actionError, setActionError] = useState<string | null>(null);
  /** "Customer notified on WhatsApp" after a status change the server sent automatically */
  const [notified, setNotified] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reporting, setReporting] = useState<Delivery | null>(null);
  const [delivered, setDelivered] = useState<DeliveredResult | null>(null);

  const active = useMemo(() => (list ?? []).filter((d) => d.status !== "DELIVERED" && d.status !== "CANCELLED"), [list]);
  const outIds = useMemo(() => active.filter((d) => d.status === "OUT_FOR_DELIVERY").map((d) => d.id), [active]);
  const live = useLiveLocation(outIds);

  const failed = (e: unknown) => {
    setActionError(e instanceof ApiError && e.isNetwork ? "No connection — nothing was changed. Try again when you have signal." : errorMessage(e));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    void load();
  };

  /** Accept / picked up (PATCH /status). */
  const advance = async (d: Delivery) => {
    const next = nextPartnerStep(d.status);
    if (!next) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionError(null);
    setNotified(null);
    setBusy(`${d.id}:advance`);
    try {
      const updated = await endpoints.deliveryStatus(d.id, next.status);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      patch(d.id, updated);
      setNotified(updated.customerMessage?.autoSent ? `${d.order.invoiceNumber}: Customer notified on WhatsApp` : null);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };

  /** One tap at the door (POST /complete), sending the amount the partner saw. */
  const complete = async (d: Delivery) => {
    setActionError(null);
    setBusy(`${d.id}:complete`);
    try {
      const r = await endpoints.completeDelivery(d.id, d.amountDue);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      patch(d.id, null);
      setDelivered({ delivery: r, cashCollected: r.cashCollected ?? 0, customerNotified: !!r.customerMessage?.autoSent });
    } catch (e) {
      if (isAmountChanged(e)) {
        setActionError("The bill changed since you opened it. Check the new amount on the card and try again.");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        void load();
      } else failed(e);
    } finally {
      setBusy(null);
    }
  };

  const onComplete = (d: Delivery) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const action = completeAction(d);
    if (!action.confirm) return void complete(d);
    Alert.alert(action.confirm.title, action.confirm.message, [
      { text: "Not yet", style: "cancel" },
      { text: action.confirm.ok, onPress: () => void complete(d) },
    ]);
  };

  if (!list && error) return <Screen scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!list) return <Screen scroll={false}><Loading label="Loading your deliveries…" /></Screen>;

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await Promise.all([load(), duty.reload(), presence?.reload()]);
        setRefreshing(false);
      }}
    >
      <Row style={{ justifyContent: "space-between" }}>
        <AppText variant="h2">My deliveries</AppText>
        <AppText variant="muted">{active.length} to deliver</AppText>
      </Row>
      {duty.onDuty === false ? (
        <View style={{ gap: space.sm }}>
          <Notice kind="warning" title="Off duty" message="Clock in to start your shift. You can still see and complete your deliveries." />
          <Button title="Go to Home · Clock in" icon="finger-print" variant="secondary" size="md" onPress={() => router.navigate("/(tabs)")} />
        </View>
      ) : null}
      <PresenceCard />
      {outIds.length ? (
        <Notice
          kind={live.error ? "warning" : "success"}
          title={live.sharing ? "Sharing live location" : "Live location"}
          message={
            live.error ??
            `The outlet sees where you are while you're out for delivery${live.lastSentAt ? ` · last sent ${formatTime(new Date(live.lastSentAt).toISOString())}` : ""}. Keep the app open.`
          }
        />
      ) : null}
      {error ? (
        <Notice
          kind="warning"
          title={cachedAt ? "Offline — showing saved list" : "Couldn't refresh"}
          message={`${error}${cachedAt ? ` · saved ${formatTime(new Date(cachedAt).toISOString())}` : ""}. Pull down to retry.`}
        />
      ) : null}
      {actionError ? <Notice kind="error" message={actionError} /> : null}
      {notified ? <Notice kind="success" message={notified} /> : null}
      {active.length === 0 ? (
        <View style={{ height: 300 }}>
          <EmptyState icon="bicycle-outline" title="No deliveries right now" message="New assignments appear here and as a notification." />
        </View>
      ) : (
        active.map((d) => {
          const next = nextPartnerStep(d.status);
          const done = canComplete(d.status) ? completeAction(d) : null;
          const out = d.status === "OUT_FOR_DELIVERY";
          return (
            <DeliveryCard key={d.id} d={d} remainingKm={live.remainingKm[d.id]} showAgent={false} showMap>
              <View style={{ gap: space.sm }}>
                {next ? (
                  <Button title={next.label} icon={next.status === "ACCEPTED" ? "hand-left-outline" : "bicycle"} size="xl" loading={busy === `${d.id}:advance`} disabled={!!busy} onPress={() => void advance(d)} />
                ) : null}
                {done ? (
                  <Button
                    title={done.title}
                    icon={d.amountDue > 0 ? "cash" : "checkmark-done"}
                    size={out ? "xl" : "lg"}
                    variant={out ? "success" : "secondary"}
                    loading={busy === `${d.id}:complete`}
                    disabled={!!busy}
                    accessibilityHint={d.amountDue > 0 ? "Asks you to confirm the cash amount" : undefined}
                    onPress={() => onComplete(d)}
                  />
                ) : null}
                <Button title="Report a problem" icon="warning-outline" variant="ghost" size="md" onPress={() => setReporting(d)} />
              </View>
            </DeliveryCard>
          );
        })
      )}

      <IssueSheet
        delivery={reporting}
        onClose={() => setReporting(null)}
        onReported={(d) => {
          setReporting(null);
          patch(d.id, d);
        }}
      />
      <DeliveredModal
        result={delivered}
        remaining={active.length}
        onDone={() => {
          setDelivered(null);
          void load();
        }}
        onViewCash={() => {
          setDelivered(null);
          void load();
          router.navigate("/(tabs)/cash");
        }}
      />
    </Screen>
  );
}

export default withAccess(["delivery:own"], MyDeliveries);
