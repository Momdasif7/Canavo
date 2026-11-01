import React from "react";
import { View } from "react-native";
import { AppText, Card, Kpi, Row } from "../components/ui";
import { inrShort } from "../lib/format";
import type { OwnerOutletDay, OwnerSummary } from "../lib/types";
import { space, useTheme } from "../theme";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const signed = (paise: number) => `${paise > 0 ? "+" : paise < 0 ? "−" : ""}${inrShort(Math.abs(paise))}`;

function cashText(c: OwnerOutletDay["cash"]) {
  if (c.status === "OPEN") return `Drawer open · ${inrShort(c.expectedCash)} expected`;
  if (c.status === "CLOSED") return c.variance === 0 ? "Last shift matched" : `Last shift ${signed(c.variance)} ${c.variance < 0 ? "short" : "over"}`;
  return "No cash shift";
}

/**
 * Owner home (Phase 4.3): today so far across the user's outlets, compared with the
 * same weekday last week up to the same time, then one row per outlet.
 */
export function OwnerSummaryView({ s }: { s: OwnerSummary }) {
  const t = useTheme();
  const tot = s.totals;
  const change = tot.lastWeek.changePercent;
  const warn = (on: boolean) => (on ? t.danger : undefined);
  const multi = s.outlets.length > 1;

  return (
    <View style={{ gap: space.sm }}>
      <AppText variant="h3">{multi ? `Today across ${s.outlets.length} outlets` : `Today at ${s.outlets[0]?.name ?? "the outlet"}`}</AppText>
      <Row style={{ flexWrap: "wrap", gap: space.md, alignItems: "stretch" }}>
        <Kpi
          label="Sales"
          value={inrShort(tot.grossSales)}
          accent={t.success}
          hint={change != null ? `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}% vs last week by now` : "No sales last week by now"}
        />
        <Kpi label="After refunds" value={inrShort(tot.salesAfterRefunds)} hint={`Last week ${inrShort(tot.lastWeek.grossSales)}`} />
        <Kpi label="Bills" value={String(tot.bills)} hint={`Avg ${inrShort(tot.averageBill)} · last week ${tot.lastWeek.bills}`} />
        <Kpi label="Voids" value={inrShort(tot.voids.amount)} accent={warn(tot.voids.count > 0)} hint={plural(tot.voids.count, "bill")} />
        <Kpi label="Refunds" value={inrShort(tot.refunds.amount)} accent={warn(tot.refunds.count > 0)} hint={plural(tot.refunds.count, "refund")} />
        <Kpi label="Big discounts" value={String(tot.bigDiscounts)} accent={warn(tot.bigDiscounts > 0)} hint="Above the approval limit" />
        <Kpi label="Not approved" value={String(tot.unapprovedApprovals)} accent={warn(tot.unapprovedApprovals > 0)} hint="Done offline without a PIN" />
        <Kpi label="Low stock" value={String(tot.lowStock)} accent={warn(tot.lowStock > 0)} hint="Items at or below reorder level" />
      </Row>

      {tot.topItems.length ? (
        <Card style={{ gap: space.xs }}>
          <AppText variant="h3">Top items</AppText>
          {tot.topItems.map((i) => (
            <Row key={i.name} style={{ justifyContent: "space-between", minHeight: 32 }}>
              <AppText style={{ flex: 1 }} numberOfLines={1}>
                {i.name}
              </AppText>
              <AppText variant="muted">
                ×{i.quantity} · {inrShort(i.amount)}
              </AppText>
            </Row>
          ))}
        </Card>
      ) : null}

      {s.outlets.map((o) => (
        <Card key={o.outletId} style={{ gap: 6 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText variant="h3" style={{ flex: 1 }} numberOfLines={1}>
              {o.name}
            </AppText>
            <AppText style={{ fontWeight: "800" }} color={t.success}>
              {inrShort(o.grossSales)}
            </AppText>
          </Row>
          <AppText variant="muted">
            {plural(o.bills, "bill")} · avg {inrShort(o.averageBill)} · last week {inrShort(o.lastWeek.grossSales)} ({o.lastWeek.bills})
          </AppText>
          <AppText variant="small" color={o.cash.status === "CLOSED" && o.cash.variance !== 0 ? t.danger : t.textMuted}>
            {cashText(o.cash)}
          </AppText>
          {o.voids.count || o.refunds.count || o.bigDiscounts || o.unapprovedApprovals || o.lowStock ? (
            <AppText variant="small" color={t.danger}>
              {[
                o.voids.count ? `${plural(o.voids.count, "void")} ${inrShort(o.voids.amount)}` : null,
                o.refunds.count ? `${plural(o.refunds.count, "refund")} ${inrShort(o.refunds.amount)}` : null,
                o.bigDiscounts ? `${plural(o.bigDiscounts, "discount")} over ${o.discountLimitPercent}%` : null,
                o.unapprovedApprovals ? `${o.unapprovedApprovals} not approved` : null,
                o.lowStock ? `${o.lowStock} low on stock` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
          ) : null}
        </Card>
      ))}
    </View>
  );
}
