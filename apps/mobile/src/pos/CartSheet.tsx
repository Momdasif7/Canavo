import React, { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { DateTimeField } from "../components/DateTimeField";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Chip, Input, Notice, Row, VegMark } from "../components/ui";
import { inr } from "../lib/format";
import type { CustomerLookupResult, OrderType, Outlet, PromotionPreview } from "../lib/types";
import { radius, space, TAP, useTheme } from "../theme";
import { useCart, type CartLine } from "./CartContext";
import { codAvailable } from "./cod";
import { CustomerSection, DeliverySection, PromoSection, Warnings } from "./CartExtras";
import { freeBadge } from "./freeItems";
import { noTaxNote, showGst, taxRows, type LocalBill, type TotalsLike } from "./localBill";
import { isItemOut, isLineOut, ranOut } from "./stock";

const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: "TAKEAWAY", label: "Takeaway" },
  { value: "DINE_IN", label: "Dine-in" },
  { value: "DELIVERY", label: "Delivery" },
  { value: "PRE_ORDER", label: "Pre-order" },
];

function LineRow({ line }: { line: CartLine }) {
  const t = useTheme();
  const { changeQty, remove } = useCart();
  const ref = useRef<Swipeable>(null);
  const detail = [line.variant?.name, ...line.addons.map((a) => `+ ${a.name}`)].filter(Boolean).join(", ");
  const free = line.free;
  const gross = line.unitPrice * line.quantity;
  const net = free ? Math.max(0, gross - Math.round((gross * free.percent) / 100)) : gross;
  // Ran out since it was added (latest menu): the server refuses it online, so flag it.
  const out = isLineOut(line);
  const outReason = out ? ranOut(line.item) : null;

  return (
    <Swipeable
      ref={ref}
      friction={2}
      rightThreshold={60}
      overshootRight={false}
      onSwipeableOpen={(dir) => dir === "right" && remove(line.key)}
      renderRightActions={() => (
        <View style={[styles.deleteAction, { backgroundColor: t.danger }]}>
          <Ionicons name="trash" size={22} color="#fff" />
          <AppText style={{ color: "#fff", fontWeight: "800" }}>Remove</AppText>
        </View>
      )}
    >
      <View
        style={[
          styles.line,
          { backgroundColor: out ? t.dangerBg : free ? t.successBg : t.surface, borderColor: out ? t.danger : free ? t.success : t.border },
        ]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ gap: 6 }}>
            <VegMark type={line.item.foodType} size={14} />
            <AppText style={{ fontWeight: "700", flex: 1 }} numberOfLines={2}>
              {line.item.name}
            </AppText>
          </Row>
          {free ? (
            <View style={[styles.freeBadge, { backgroundColor: t.success }]} accessibilityLabel={`Added by offer ${free.offerName}`}>
              <Ionicons name="gift" size={12} color="#fff" />
              <AppText style={styles.freeBadgeText} numberOfLines={1}>
                {freeBadge(free.percent, free.offerName)}
              </AppText>
            </View>
          ) : null}
          {detail ? <AppText variant="small" numberOfLines={2}>{detail}</AppText> : null}
          {out ? (
            <AppText variant="small" color={t.danger} style={{ fontWeight: "700" }} numberOfLines={2}>
              {isItemOut(line.item) ? "Out of stock" : `${line.variant?.name ?? "This size"} is out of stock`}
              {outReason ? ` · ${outReason}` : ""}
            </AppText>
          ) : null}
          <Row style={{ gap: 6, flexWrap: "wrap" }}>
            {free ? (
              <AppText variant="small" style={{ textDecorationLine: "line-through" }}>
                {inr(gross)}
              </AppText>
            ) : null}
            <AppText variant="price" color={free ? t.success : undefined}>
              {free && net === 0 ? "FREE" : inr(net)}
            </AppText>
          </Row>
        </View>
        {free ? (
          // Auto-added: quantity follows the offer. Removing it stops re-adding until the bill is cleared.
          <Row style={{ gap: 4 }}>
            <AppText variant="h3" style={{ minWidth: 30, textAlign: "center" }}>
              ×{line.quantity}
            </AppText>
            <Pressable
              onPress={() => remove(line.key)}
              style={[styles.qtyBtn, { borderColor: t.border }]}
              accessibilityRole="button"
              accessibilityLabel={`Remove free ${line.item.name}`}
            >
              <Ionicons name="close" size={22} color={t.danger} />
            </Pressable>
          </Row>
        ) : (
          <Row style={{ gap: 4 }}>
            <Pressable
              onPress={() => changeQty(line.key, -1)}
              style={[styles.qtyBtn, { borderColor: t.border }]}
              accessibilityLabel={`Remove one ${line.item.name}`}
            >
              <Ionicons name={line.quantity === 1 ? "trash-outline" : "remove"} size={22} color={line.quantity === 1 ? t.danger : t.text} />
            </Pressable>
            <AppText variant="h3" style={{ minWidth: 30, textAlign: "center" }}>
              {line.quantity}
            </AppText>
            <Pressable
              onPress={() => changeQty(line.key, 1)}
              style={[styles.qtyBtn, { borderColor: t.primary, backgroundColor: t.primary }]}
              accessibilityLabel={`Add one ${line.item.name}`}
            >
              <Ionicons name="add" size={22} color={t.primaryText} />
            </Pressable>
          </Row>
        )}
      </View>
    </Swipeable>
  );
}

function TotalRow({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <Row style={{ justifyContent: "space-between" }}>
      <AppText variant={strong ? "h3" : "muted"} color={color}>
        {label}
      </AppText>
      <AppText variant={strong ? "price" : "body"} color={color} style={strong ? { fontSize: 24 } : { fontVariant: ["tabular-nums"] }}>
        {value}
      </AppText>
    </Row>
  );
}

/** Totals from the server preview when available, else the local computeBill. */
function Totals({
  bill,
  preview,
  outlet,
}: {
  bill: LocalBill;
  preview: PromotionPreview | null;
  /** null while loading → no GST rows yet */
  outlet: Outlet | null;
}) {
  const t = useTheme();
  const b: TotalsLike = preview?.bill ?? bill;
  // GST rows only when the outlet is known, GST is on and both the local and server bills are tax invoices.
  const gst = showGst(b, outlet) && showGst(bill, outlet);
  const rows = gst ? taxRows(b, outlet) : [];
  const note = gst ? null : noTaxNote(b.documentType === "TAX_INVOICE" ? "BILL" : b.documentType, outlet?.gstEnabled);
  const pricesIncludeTax = outlet?.pricesIncludeTax ?? true;
  const manualDiscount = preview ? Math.max(0, preview.bill.discount - preview.promoDiscount) : bill.discount;
  return (
    <View style={[styles.totals, { backgroundColor: t.surfaceAlt }]}>
      <TotalRow label={pricesIncludeTax && gst ? "Items (excl. tax)" : "Subtotal"} value={inr(b.subtotal)} />
      {manualDiscount ? <TotalRow label="Discount" value={`-${inr(manualDiscount)}`} /> : null}
      {preview?.applied.map((a, i) => (
        <TotalRow key={`${a.kind}-${i}`} label={a.label} value={`-${inr(a.amount)}`} color={t.success} />
      ))}
      {preview?.charges.map((c) => <TotalRow key={c.label} label={c.label} value={inr(c.amount)} />)}
      {b.serviceCharge ? <TotalRow label="Service charge" value={inr(b.serviceCharge)} /> : null}
      {rows.map((r) => (
        <TotalRow key={r.label} label={r.label} value={inr(r.amount)} />
      ))}
      {note ? <AppText variant="small">{note}</AppText> : null}
      {b.roundOff ? <TotalRow label="Round off" value={inr(b.roundOff)} /> : null}
      <View style={{ height: 1, backgroundColor: t.border }} />
      <TotalRow label="Total" value={inr(b.grandTotal)} strong />
      <AppText variant="small">{preview ? "Checked with the server: offers, coupon and charges applied." : "Estimate — offers and charges are applied by the server."}</AppText>
    </View>
  );
}

export function CartSheet({
  visible,
  onClose,
  bill,
  preview,
  previewError,
  previewLoading,
  lookup,
  outlet,
  charging,
  error,
  online,
  features,
  onCharge,
}: {
  visible: boolean;
  onClose: () => void;
  bill: LocalBill | null;
  preview: PromotionPreview | null;
  previewError: string | null;
  previewLoading: boolean;
  lookup: { customer: CustomerLookupResult | null; loading: boolean; error: string | null };
  /** Outlet settings (GST on/off); null while loading */
  outlet: Outlet | null;
  charging: boolean;
  error: string | null;
  online: boolean;
  /** From posFeatures(): which modules the business has enabled */
  features: { customers: boolean; points: boolean; coupons: boolean; delivery: boolean; preOrder: boolean; tables: boolean; cod?: boolean };
  onCharge: () => void;
}) {
  const t = useTheme();
  const { state, setOrderType, setTable, setScheduledFor, clear } = useCart();
  const canLookup = features.customers;
  const types = ORDER_TYPES.filter(
    (o) => (o.value !== "DELIVERY" || features.delivery) && (o.value !== "PRE_ORDER" || features.preOrder),
  );
  // Delivery / pre-order need the customer's name & phone even without the customers module.
  const showCustomer = features.customers || state.orderType === "DELIVERY" || state.orderType === "PRE_ORDER";
  const showPromos = features.coupons || features.points;
  const total = preview?.bill.grandTotal ?? bill?.grandTotal;
  const promosOffline = !online && (state.couponCode || state.redeemPoints > 0);
  const outLines = state.lines.filter(isLineOut).length;
  const placeCod = !!features.cod && state.delivery.cod && codAvailable(state.orderType, online);
  const chargeTitle = placeCod
    ? `Place COD order${total != null ? ` · ${inr(total)}` : ""}`
    : total != null
      ? `Charge ${inr(total)}`
      : "Charge";

  return (
    <Sheet visible={visible} onClose={onClose} maxHeight="94%">
      <Row style={{ justifyContent: "space-between", paddingHorizontal: space.lg }}>
        <AppText variant="h2">Current bill</AppText>
        {state.lines.length ? (
          <Pressable onPress={clear} hitSlop={10} style={{ minHeight: 44, justifyContent: "center" }} accessibilityRole="button">
            <AppText color={t.danger} style={{ fontWeight: "700" }}>
              Clear
            </AppText>
          </Pressable>
        ) : null}
      </Row>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }} keyboardShouldPersistTaps="handled">
        <Row style={{ flexWrap: "wrap" }}>
          {types.map((o) => (
            <Chip key={o.value} label={o.label} selected={state.orderType === o.value} onPress={() => setOrderType(o.value)} />
          ))}
        </Row>
        {state.orderType === "DINE_IN" && features.tables ? (
          <Input placeholder="Table (e.g. T4)" value={state.tableLabel} onChangeText={setTable} maxLength={20} autoCapitalize="characters" />
        ) : null}
        {state.orderType === "PRE_ORDER" ? (
          <DateTimeField
            label="When does the customer want it?"
            value={state.scheduledFor}
            onChange={setScheduledFor}
            maximumDate={new Date(Date.now() + 30 * 86_400_000)}
          />
        ) : null}

        {state.lines.length === 0 ? (
          <AppText variant="muted" style={{ textAlign: "center", paddingVertical: space.xl }}>
            Cart is empty. Tap items to add them.
          </AppText>
        ) : (
          <>
            <AppText variant="small">Swipe a line left to remove it.</AppText>
            {state.lines.map((l) => (
              <LineRow key={l.key} line={l} />
            ))}
          </>
        )}

        {showCustomer ? (
          <>
            <AppText variant="h3">Customer</AppText>
            <CustomerSection
              lookup={canLookup ? lookup.customer : null}
              loading={canLookup && lookup.loading}
              error={canLookup ? lookup.error : null}
              nameRequired={state.orderType === "DELIVERY"}
            />
          </>
        ) : null}

        {state.orderType === "DELIVERY" ? (
          <>
            <AppText variant="h3">Delivery</AppText>
            <DeliverySection online={online} total={total} codEnabled={!!features.cod} outlet={outlet} />
          </>
        ) : null}

        {showPromos ? (
          <>
            <AppText variant="h3">{features.coupons && features.points ? "Offers & loyalty" : features.coupons ? "Coupon" : "Loyalty"}</AppText>
            <PromoSection
              lookup={features.points ? lookup.customer : null}
              preview={preview}
              online={online}
              coupons={features.coupons}
            />
          </>
        ) : null}

        {!showPromos && preview?.warnings?.length ? <Warnings items={preview.warnings} /> : null}
        {bill ? <Totals bill={bill} preview={preview} outlet={outlet} /> : null}
        {previewLoading && !preview ? <AppText variant="small">Checking offers…</AppText> : null}
        {previewError ? <Notice kind="warning" title="Server check" message={previewError} /> : null}

        {error ? <Notice kind="error" message={error} /> : null}
        {outLines && online ? (
          <Notice
            kind="warning"
            message={`${outLines === 1 ? "1 item is" : `${outLines} items are`} out of stock. Remove ${outLines === 1 ? "it" : "them"} (swipe left) to charge this bill.`}
          />
        ) : null}
        {!online ? (
          <Notice kind="warning" message="You're offline. The bill will be saved on this phone and synced later (cash/card only)." />
        ) : null}
        {promosOffline ? <Notice kind="warning" message="Coupons and points need a connection — they won't apply to an offline bill." /> : null}
        <Button
          title={chargeTitle}
          size="xl"
          variant="success"
          icon={placeCod ? "bicycle" : "cash-outline"}
          disabled={!bill}
          loading={charging}
          onPress={onCharge}
        />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  qtyBtn: { width: TAP - 4, height: TAP - 4, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  deleteAction: {
    justifyContent: "center",
    alignItems: "center",
    width: 110,
    borderRadius: radius.md,
    marginLeft: space.sm,
    gap: 2,
  },
  totals: { borderRadius: radius.md, padding: space.md, gap: 6 },
  freeBadge: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  freeBadgeText: { color: "#fff", fontWeight: "900", fontSize: 12, flexShrink: 1 },
});
