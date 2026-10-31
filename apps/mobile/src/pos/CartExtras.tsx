import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button, Chip, Input, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { humanize, inr, inrShort } from "../lib/format";
import { useSocketEvent } from "../lib/socket";
import type { CustomerLookupResult, DeliveryAgent, DeliveryQuote, Outlet, PromotionPreview } from "../lib/types";
import { MapPicker, type PickedLocation } from "../delivery/MapPicker";
import { MiniMap } from "../delivery/MiniMap";
import { reverseGeocode } from "../delivery/nominatim";
import { partnerState } from "../delivery/portal";
import { radius, space, useTheme } from "../theme";
import { useCart } from "./CartContext";
import { codCopy } from "./cod";

export const TIER_COLORS: Record<string, string> = {
  BRONZE: "#A0522D",
  SILVER: "#7D8597",
  GOLD: "#C9A227",
  PLATINUM: "#5E60CE",
};

export function TierBadge({ tier }: { tier: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: TIER_COLORS[tier] ?? "#777" }]}>
      <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{humanize(tier)}</AppText>
    </View>
  );
}

// ---------- Customer ----------
export function CustomerSection({
  lookup,
  loading,
  error,
  nameRequired,
}: {
  lookup: CustomerLookupResult | null;
  loading: boolean;
  error: string | null;
  nameRequired: boolean;
}) {
  const t = useTheme();
  const { state, setPhone, setName } = useCart();

  // Prefill the name of a known customer.
  useEffect(() => {
    if (lookup?.found && lookup.name && !state.customerName) setName(lookup.name);
    // Only when a new lookup result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup?.id]);

  return (
    <View style={{ gap: space.sm }}>
      <Input
        placeholder={nameRequired ? "Customer mobile (required)" : "Customer mobile (optional)"}
        value={state.customerPhone}
        onChangeText={(v) => setPhone(v.replace(/\D/g, "").slice(0, 10))}
        keyboardType="phone-pad"
        maxLength={10}
      />
      {loading ? (
        <Row>
          <ActivityIndicator color={t.primary} />
          <AppText variant="small">Looking up customer…</AppText>
        </Row>
      ) : null}
      {error ? <Notice kind="warning" message={`Customer lookup failed: ${error}`} /> : null}
      {lookup ? (
        lookup.found ? (
          <View style={[styles.customer, { backgroundColor: t.surfaceAlt, borderColor: lookup.blocked ? t.danger : t.border }]}>
            <Row style={{ justifyContent: "space-between" }}>
              <AppText variant="h3" style={{ flex: 1 }} numberOfLines={1}>
                {lookup.name || "Customer"}
              </AppText>
              {lookup.tier ? <TierBadge tier={lookup.tier} /> : null}
            </Row>
            <Row style={{ flexWrap: "wrap", gap: space.md }}>
              <AppText variant="small">
                <AppText style={{ fontWeight: "800" }}>{lookup.points ?? 0}</AppText> pts
                {lookup.redeemableValue ? ` (worth ${inrShort(lookup.redeemableValue)})` : ""}
              </AppText>
              <AppText variant="small">{lookup.visitCount ?? 0} visits</AppText>
              {lookup.khataBalance ? (
                <AppText variant="small" color={t.warning} style={{ fontWeight: "800" }}>
                  Khata due {inr(lookup.khataBalance)}
                </AppText>
              ) : null}
            </Row>
            {lookup.blocked ? <Notice kind="error" message="This customer is blocked. The bill will be refused." /> : null}
          </View>
        ) : (
          <AppText variant="small">New customer — they'll be saved with this bill.</AppText>
        )
      ) : null}
      {nameRequired || state.customerName || lookup ? (
        <Input placeholder={nameRequired ? "Customer name (required)" : "Customer name"} value={state.customerName} onChangeText={setName} maxLength={100} />
      ) : null}
    </View>
  );
}

// ---------- Server warnings ----------
/** Problems the preview reported (bad coupon, points, delivery details); the totals stay valid. */
export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {items.map((w, i) => (
        <Notice key={`${i}-${w}`} kind="warning" message={w} />
      ))}
    </View>
  );
}

// ---------- Coupon / points ----------
export function PromoSection({
  lookup,
  preview,
  online,
  coupons = true,
}: {
  lookup: CustomerLookupResult | null;
  preview: PromotionPreview | null;
  online: boolean;
  /** Coupon entry (OFFERS module) */
  coupons?: boolean;
}) {
  const t = useTheme();
  const { state, setCoupon, setRedeemPoints } = useCart();
  const [code, setCode] = useState(state.couponCode);
  useEffect(() => setCode(state.couponCode), [state.couponCode]);

  const redeemable = lookup?.found ? lookup.redeemablePoints ?? 0 : 0;
  const usingPoints = state.redeemPoints > 0;

  return (
    <View style={{ gap: space.sm }}>
      {coupons ? (
        <Row>
          <View style={{ flex: 1 }}>
            <Input
              placeholder="Coupon code"
              value={code}
              onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
              autoCapitalize="characters"
              maxLength={30}
              editable={!state.couponCode}
            />
          </View>
          {state.couponCode ? (
            <Button title="Remove" variant="secondary" size="md" onPress={() => setCoupon("")} />
          ) : (
            <Button
              title="Apply"
              size="md"
              disabled={code.length < 3 || !online}
              onPress={() => {
                setCoupon(code);
                void Haptics.selectionAsync();
              }}
            />
          )}
        </Row>
      ) : null}
      {redeemable > 0 ? (
        <Pressable
          onPress={() => setRedeemPoints(usingPoints ? 0 : redeemable)}
          accessibilityRole="switch"
          accessibilityState={{ checked: usingPoints }}
          style={[styles.toggle, { borderColor: usingPoints ? t.primary : t.border, backgroundColor: t.surface }]}
        >
          <Ionicons name={usingPoints ? "checkbox" : "square-outline"} size={24} color={usingPoints ? t.primary : t.textMuted} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontWeight: "700" }}>Redeem loyalty points</AppText>
            <AppText variant="small">
              {redeemable} available · max {lookup?.loyalty.maxRedeemPercent ?? 50}% of the bill
              {preview?.pointsRedeemed ? ` · using ${preview.pointsRedeemed} (${inr(preview.pointsValue)})` : ""}
            </AppText>
          </View>
        </Pressable>
      ) : null}
      {/* Coupon / points problems: shown right under the inputs; the bill keeps the server totals. */}
      <Warnings items={preview?.warnings ?? []} />
      {preview?.applied.length ? (
        <View style={{ gap: 4 }}>
          {preview.applied.map((a, i) => (
            <Row key={`${a.kind}-${a.id ?? i}`}>
              <Ionicons name={a.kind === "COUPON" ? "pricetag" : a.kind === "POINTS" ? "star" : "gift"} size={16} color={t.success} />
              <AppText style={{ flex: 1 }} color={t.success}>
                {a.label}
              </AppText>
              <AppText color={t.success} style={{ fontWeight: "800" }}>
                −{inr(a.amount)}
              </AppText>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ---------- Delivery ----------
export function DeliverySection({
  online,
  total,
  codEnabled = false,
  outlet = null,
}: {
  online: boolean;
  /** Bill total (paise) for the COD copy */
  total?: number | null;
  /** Show the Cash on Delivery toggle (needs `payment:collect`) */
  codEnabled?: boolean;
  /** Outlet (position for the map); fetched by the picker when missing */
  outlet?: Outlet | null;
}) {
  const t = useTheme();
  const { state, patchDelivery } = useCart();
  const d = state.delivery;
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [agents, setAgents] = useState<DeliveryAgent[] | null>(null);
  const [locating, setLocating] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadQuote = useCallback(async (coords?: { lat: number; lng: number }) => {
    try {
      setQuote(await endpoints.deliveryQuote(coords ?? {}));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const loadAgents = useCallback(() => {
    endpoints
      .deliveryAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!online) return;
    void loadQuote(d.latitude != null && d.longitude != null ? { lat: d.latitude, lng: d.longitude } : undefined);
    loadAgents();
    // Once per open; location updates call loadQuote directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  // Partners clocking in / finishing deliveries change who's available.
  useSocketEvent("delivery:updated", loadAgents);

  const useMyLocation = async () => {
    setLocating(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") throw new Error("Location permission is needed to pin the address.");
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const { latitude, longitude } = pos.coords;
      patchDelivery({ latitude, longitude, zoneId: undefined });
      if (!d.address.trim()) {
        const text = await reverseGeocode({ lat: latitude, lng: longitude }).catch(() => null);
        if (text) patchDelivery({ address: text });
      }
      await loadQuote({ lat: latitude, lng: longitude });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(errorMessage(e, "Could not get your location"));
    } finally {
      setLocating(false);
    }
  };

  const onPicked = (p: PickedLocation) => {
    setMapOpen(false);
    patchDelivery({ latitude: p.lat, longitude: p.lng, zoneId: undefined, ...(p.fillAddress && p.address ? { address: p.address } : {}) });
    void loadQuote({ lat: p.lat, lng: p.lng });
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const hasCoords = d.latitude != null && d.longitude != null;
  const zones = quote?.zones ?? [];
  const outletPos = outlet && outlet.latitude != null && outlet.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null;

  if (!online) return <Notice kind="warning" message="Delivery orders need a connection." />;

  return (
    <View style={{ gap: space.sm }}>
      <Input
        placeholder="Delivery address (required)"
        value={d.address}
        onChangeText={(v) => patchDelivery({ address: v })}
        multiline
        maxLength={500}
        style={{ minHeight: 72, paddingTop: 12, textAlignVertical: "top" }}
      />
      <Input placeholder="Landmark (optional)" value={d.landmark} onChangeText={(v) => patchDelivery({ landmark: v })} maxLength={200} />

      {hasCoords ? (
        <MiniMap
          pin={{ lat: d.latitude!, lng: d.longitude! }}
          outlet={outletPos}
          height={150}
          label="Pinned · tap to adjust"
          onPress={() => setMapOpen(true)}
        />
      ) : null}
      <Row>
        <Button
          title={hasCoords ? "Adjust pin" : "Pick on map"}
          icon="map"
          size="md"
          style={{ flex: 1 }}
          onPress={() => setMapOpen(true)}
        />
        <Button
          title="My location"
          icon="locate-outline"
          variant="secondary"
          size="md"
          style={{ flex: 1 }}
          loading={locating}
          onPress={useMyLocation}
        />
      </Row>
      {hasCoords ? (
        <Pressable
          onPress={() => {
            patchDelivery({ latitude: undefined, longitude: undefined });
            void loadQuote();
          }}
          hitSlop={8}
          style={{ minHeight: 40, justifyContent: "center", alignSelf: "flex-start" }}
          accessibilityRole="button"
        >
          <AppText color={t.danger} style={{ fontWeight: "700" }}>
            Remove pin
          </AppText>
        </Pressable>
      ) : null}

      {quote && quote.deliveryEnabled === false ? <Notice kind="error" message="Delivery is switched off for this outlet." /> : null}
      {quote && quote.distanceKm != null ? (
        quote.deliverable ? (
          <Notice
            kind="success"
            message={`${quote.distanceKm} km · ${quote.zone?.name ?? "zone"} · fee ${inr(quote.fee ?? 0)} · ~${quote.etaMinutes ?? "?"} min${
              quote.minOrder ? ` · min order ${inrShort(quote.minOrder)}` : ""
            }`}
          />
        ) : (
          <Notice kind="error" message={`${quote.distanceKm} km away — outside our delivery zones.`} />
        )
      ) : null}
      {!hasCoords && zones.length ? (
        <View style={{ gap: 6 }}>
          <AppText variant="small">No pin? Choose the zone:</AppText>
          <Row style={{ flexWrap: "wrap" }}>
            {zones.map((z) => (
              <Chip
                key={z.id}
                label={`${z.name} · ${z.radiusKm} km · ${inrShort(z.fee)}`}
                selected={d.zoneId === z.id}
                onPress={() => patchDelivery({ zoneId: d.zoneId === z.id ? undefined : z.id })}
              />
            ))}
          </Row>
        </View>
      ) : null}

      <AgentPicker agents={agents} selected={d.agentId} onSelect={(agentId) => patchDelivery({ agentId })} />

      {codEnabled ? (
        <CodToggle
          on={d.cod}
          partner={(agents ?? []).find((a) => a.id === d.agentId)?.name ?? null}
          total={total ?? null}
          onToggle={() => patchDelivery({ cod: !d.cod })}
        />
      ) : null}
      {error ? <Notice kind="error" message={error} /> : null}

      <MapPicker
        visible={mapOpen}
        initial={hasCoords ? { lat: d.latitude!, lng: d.longitude! } : null}
        outlet={outlet}
        addressEmpty={!d.address.trim()}
        onClose={() => setMapOpen(false)}
        onConfirm={onPicked}
      />
    </View>
  );
}

/** Picker line for a partner: "available 1/2" / "out for delivery" / "not clocked in"… */
function pickerStatus(a: DeliveryAgent): string {
  switch (partnerState(a)) {
    case "off":
      return "not clocked in";
    case "available":
      return `available ${a.active}/${a.max}`;
    case "out":
      return "out for delivery";
    case "returning":
      return "returning to outlet";
    default:
      return `full ${a.active}/${a.max}`;
  }
}

/**
 * Delivery partner choice. Default: auto-assign — the server gives the order
 * to the next available partner (at the outlet, under the per-partner limit),
 * or it waits and is auto-assigned when someone is back.
 */
function AgentPicker({
  agents,
  selected,
  onSelect,
}: {
  agents: DeliveryAgent[] | null;
  selected: string | undefined;
  onSelect: (agentId: string | undefined) => void;
}) {
  const t = useTheme();
  const auto = !selected;
  const available = (agents ?? []).filter((a) => a.available).length;
  return (
    <View style={{ gap: 6 }}>
      <AppText variant="small">Delivery partner</AppText>
      <Pressable
        onPress={() => onSelect(undefined)}
        accessibilityRole="radio"
        accessibilityState={{ checked: auto }}
        style={({ pressed }) => [
          styles.auto,
          { borderColor: auto ? t.primary : t.border, backgroundColor: auto ? t.surfaceAlt : pressed ? t.surfaceAlt : t.surface },
        ]}
      >
        <Ionicons name={auto ? "radio-button-on" : "radio-button-off"} size={24} color={auto ? t.primary : t.textMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText style={{ fontWeight: "800" }}>Auto-assign (next available)</AppText>
          <AppText variant="small" color={agents && available === 0 ? t.warning : t.textMuted}>
            {agents == null
              ? "Checking who's available…"
              : available === 0
                ? "No partner free right now — the order waits and is auto-assigned when one is back at the outlet"
                : `${available} available at the outlet · goes to the next free partner`}
          </AppText>
        </View>
        <View style={[styles.dutyBadge, { backgroundColor: available ? t.success : t.border }]}>
          <AppText style={{ color: "#fff", fontWeight: "900" }}>{agents == null ? "…" : available}</AppText>
        </View>
      </Pressable>
      {agents?.length ? (
        <>
          <AppText variant="small">Or pick one:</AppText>
          {agents.map((a) => {
            const on = selected === a.id;
            const st = partnerState(a);
            const color = st === "available" ? t.success : st === "off" ? t.textMuted : t.warning;
            return (
              <Pressable
                key={a.id}
                onPress={() => onSelect(on ? undefined : a.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${a.name}, ${pickerStatus(a)}`}
                style={({ pressed }) => [
                  styles.partner,
                  { borderColor: on ? t.primary : t.border, backgroundColor: on || pressed ? t.surfaceAlt : t.surface },
                ]}
              >
                <View style={[styles.partnerDot, { backgroundColor: color }]} />
                <AppText style={{ flex: 1, fontWeight: "700" }} numberOfLines={1}>
                  {a.name}
                </AppText>
                <AppText variant="small" color={color} style={{ fontWeight: "700" }}>
                  {pickerStatus(a)}
                </AppText>
                {on ? <Ionicons name="checkmark-circle" size={22} color={t.primary} /> : null}
              </Pressable>
            );
          })}
          {selected && agents.some((a) => a.id === selected && !a.available) ? (
            <Notice kind="warning" message={`${agents.find((a) => a.id === selected)!.name} can't take a new order right now. Pick someone available or use Auto-assign.`} />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Big switch row: "Cash on Delivery (COD)". */
function CodToggle({ on, partner, total, onToggle }: { on: boolean; partner: string | null; total: number | null; onToggle: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onToggle();
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Cash on Delivery"
      style={({ pressed }) => [
        styles.cod,
        { borderColor: on ? t.warning : t.border, backgroundColor: on ? t.warningBg : pressed ? t.surfaceAlt : t.surface },
      ]}
    >
      <Ionicons name="cash" size={28} color={on ? t.warning : t.textMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontWeight: "900" }} color={on ? t.warning : t.text}>
          Cash on Delivery (COD)
        </AppText>
        <AppText variant="small" color={on ? t.warning : t.textMuted}>
          {on ? codCopy(partner, total) : "Customer pays cash to the delivery partner at the door"}
        </AppText>
      </View>
      <View style={[styles.switchTrack, { backgroundColor: on ? t.warning : t.border }]}>
        <View style={[styles.switchThumb, { alignSelf: on ? "flex-end" : "flex-start" }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cod: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 2, borderRadius: radius.md, padding: space.md, minHeight: 64 },
  switchTrack: { width: 52, height: 30, borderRadius: 15, padding: 3, justifyContent: "center" },
  switchThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff" },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  customer: { borderWidth: 1.5, borderRadius: radius.md, padding: space.md, gap: 6 },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: 56 },
  auto: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 2, borderRadius: radius.md, padding: space.md, minHeight: 64 },
  partner: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 48 },
  partnerDot: { width: 10, height: 10, borderRadius: 5 },
  dutyBadge: { minWidth: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
});
