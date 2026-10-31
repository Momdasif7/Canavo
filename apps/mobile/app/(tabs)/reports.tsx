import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { AppText, Card, ErrorState, Kpi, Loading, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { addDaysYmd, humanize, inr, inrShort, ymd } from "../../src/lib/format";
import type { DailyReport, OutletsOverview, SalesReport } from "../../src/lib/types";
import { TrendBars } from "../../src/components/TrendBars";
import { brand, radius, space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

function ShareBar({ label, amount, total, sub, color }: { label: string; amount: number; total: number; sub?: string; color: string }) {
  const t = useTheme();
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;
  return (
    <View style={{ gap: 4 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <AppText style={{ fontWeight: "700" }}>
          {label}
          {sub ? <AppText variant="small"> · {sub}</AppText> : null}
        </AppText>
        <AppText style={{ fontWeight: "800", fontVariant: ["tabular-nums"] }}>
          {inr(amount)} <AppText variant="small">{pct}%</AppText>
        </AppText>
      </Row>
      <View style={[styles.track, { backgroundColor: t.surfaceAlt }]}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function change(p: number | null) {
  if (p == null) return undefined;
  return `${p >= 0 ? "▲" : "▼"} ${Math.abs(p)}% vs yesterday`;
}

function Reports() {
  const t = useTheme();
  const { outlet, me, switchOutlet, allowed } = useSignedIn();
  // Manager-level users (and anyone working across outlets) see the per-outlet overview.
  const showOverview = allowed("staff:manage") || me.outlets.length > 1;
  const [trend, setTrend] = useState<SalesReport | null>(null);
  const [overview, setOverview] = useState<OutletsOverview | null>(null);
  const [date, setDate] = useState(ymd());
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [daily, sales, multi] = await Promise.all([
        endpoints.dailyReport(date),
        endpoints.salesReport(addDaysYmd(date, -6), date).catch(() => null),
        showOverview ? endpoints.outletsOverview(date).catch(() => null) : Promise.resolve(null),
      ]);
      setReport(daily);
      setTrend(sales);
      setOverview(multi);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [date, showOverview]);

  useEffect(() => {
    void load();
  }, [load, outlet?.id]);

  const isToday = date === ymd();
  const modeColors: Record<string, string> = { CASH: brand.forest, UPI: brand.saffron, CARD: t.info, KHATA: t.warning };
  const label = isToday
    ? "Today"
    : date === addDaysYmd(ymd(), -1)
      ? "Yesterday"
      : new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

  return (
    <Screen refreshing={loading && !!report} onRefresh={load}>
      <Row style={{ justifyContent: "space-between" }}>
        <Pressable onPress={() => setDate(addDaysYmd(date, -1))} style={styles.nav} accessibilityLabel="Previous day">
          <Ionicons name="chevron-back" size={26} color={t.text} />
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <AppText variant="h2">{label}</AppText>
          <AppText variant="small">{outlet?.name}</AppText>
        </View>
        <Pressable
          onPress={() => setDate(addDaysYmd(date, 1))}
          disabled={isToday}
          style={[styles.nav, isToday && { opacity: 0.3 }]}
          accessibilityLabel="Next day"
        >
          <Ionicons name="chevron-forward" size={26} color={t.text} />
        </Pressable>
      </Row>

      {error && !report ? (
        <ErrorState message={error} onRetry={load} />
      ) : !report ? (
        <View style={{ height: 300 }}>
          <Loading />
        </View>
      ) : (
        <>
          <View style={styles.kpis}>
            <Kpi label="Gross sales" value={inrShort(report.grossSales)} accent={t.success} hint={change(report.comparison.yesterday.changePercent)} />
            <Kpi label="Bills" value={String(report.orders)} hint={report.cancelledOrders ? `${report.cancelledOrders} cancelled` : undefined} />
          </View>
          <View style={styles.kpis}>
            <Kpi label="Avg bill" value={inrShort(report.averageOrderValue)} />
            <Kpi label="Net (ex-GST)" value={inrShort(report.netSales)} />
          </View>
          <View style={styles.kpis}>
            <Kpi label="GST collected" value={inrShort(report.tax.cgst + report.tax.sgst + report.tax.igst)} />
            <Kpi label="Discounts" value={inrShort(report.discounts)} />
          </View>

          {trend ? (
            <Card style={{ gap: space.sm }}>
              <Row style={{ justifyContent: "space-between" }}>
                <AppText variant="h3">Last 7 days</AppText>
                <AppText variant="muted">
                  {inrShort(trend.totals.gross)} · {trend.totals.orders} bills
                </AppText>
              </Row>
              <TrendBars points={trend.periods.map((p) => ({ date: p.period, value: p.gross, orders: p.orders }))} />
            </Card>
          ) : null}

          {overview && overview.outlets.length ? (
            <Card style={{ gap: space.sm }}>
              <Row style={{ justifyContent: "space-between" }}>
                <AppText variant="h3">All outlets</AppText>
                <AppText variant="muted">{inrShort(overview.totals.gross)}</AppText>
              </Row>
              {overview.outlets.map((o) => {
                const active = o.outletId === outlet?.id;
                return (
                  <Pressable
                    key={o.outletId}
                    onPress={() => !active && me.outlets.some((x) => x.id === o.outletId) && void switchOutlet(o.outletId)}
                    accessibilityRole="button"
                    accessibilityLabel={`${o.name}: ${inr(o.gross)}, ${o.orders} bills${active ? ", current outlet" : ". Tap to switch"}`}
                    style={[styles.outletRow, { borderColor: active ? t.primary : t.border }]}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <AppText style={{ fontWeight: "800" }} numberOfLines={1}>
                        {o.name}
                      </AppText>
                      <AppText variant="small">
                        {o.orders} bills · avg {inrShort(o.aov)}
                        {o.openBills ? ` · ${o.openBills} open (${inrShort(o.openBillsValue)})` : ""}
                      </AppText>
                      <AppText variant="small">
                        {o.staffClockedIn} on duty
                        {o.lowStock ? ` · ${o.lowStock} low stock` : ""}
                        {o.cancelled ? ` · ${o.cancelled} cancelled` : ""}
                      </AppText>
                    </View>
                    <AppText style={{ fontWeight: "900", fontVariant: ["tabular-nums"] }}>{inrShort(o.gross)}</AppText>
                  </Pressable>
                );
              })}
            </Card>
          ) : null}

          <Card style={{ gap: space.md }}>
            <AppText variant="h3">Payment modes</AppText>
            {Object.keys(report.byPaymentMode).length === 0 ? <AppText variant="muted">No payments yet.</AppText> : null}
            {Object.entries(report.byPaymentMode)
              .sort((a, b) => b[1].amount - a[1].amount)
              .map(([mode, v]) => (
                <ShareBar
                  key={mode}
                  label={humanize(mode)}
                  sub={`${v.count} txn`}
                  amount={v.amount}
                  total={Object.values(report.byPaymentMode).reduce((s, x) => s + x.amount, 0)}
                  color={modeColors[mode] ?? t.textMuted}
                />
              ))}
          </Card>

          {Object.keys(report.byOrderType).length ? (
            <Card style={{ gap: space.md }}>
              <AppText variant="h3">Order types</AppText>
              {Object.entries(report.byOrderType).map(([type, v]) => (
                <ShareBar key={type} label={humanize(type)} sub={`${v.orders} bills`} amount={v.amount} total={report.grossSales} color={brand.forest} />
              ))}
            </Card>
          ) : null}

          <Card style={{ gap: space.sm }}>
            <AppText variant="h3">Top items</AppText>
            {report.topItems.length === 0 ? <AppText variant="muted">No sales yet.</AppText> : null}
            {report.topItems.map((it, i) => (
              <Row key={it.menuItemId + it.name} style={{ minHeight: 40 }}>
                <View style={[styles.rank, { backgroundColor: i === 0 ? brand.saffron : t.surfaceAlt }]}>
                  <AppText style={{ fontWeight: "800", color: i === 0 ? "#fff" : t.text }}>{i + 1}</AppText>
                </View>
                <AppText style={{ flex: 1, fontWeight: "600" }} numberOfLines={1}>
                  {it.name}
                </AppText>
                <AppText variant="muted">× {it.quantity}</AppText>
                <AppText style={{ fontWeight: "800", minWidth: 90, textAlign: "right", fontVariant: ["tabular-nums"] }}>{inr(it.amount)}</AppText>
              </Row>
            ))}
          </Card>

          {report.staff.length ? (
            <Card style={{ gap: space.sm }}>
              <AppText variant="h3">By cashier</AppText>
              {report.staff.map((s) => (
                <Row key={s.id} style={{ justifyContent: "space-between", minHeight: 36 }}>
                  <AppText>{s.name}</AppText>
                  <AppText variant="muted">
                    {s.bills} bills · <AppText style={{ fontWeight: "800" }}>{inr(s.amount)}</AppText>
                  </AppText>
                </Row>
              ))}
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  kpis: { flexDirection: "row", gap: space.md },
  track: { height: 10, borderRadius: radius.pill, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill },
  outletRow: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, minHeight: 56 },
  rank: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["report:view"], Reports);
