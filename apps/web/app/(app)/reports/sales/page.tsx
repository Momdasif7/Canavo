"use client";

import { useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ColumnChart } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import {
  fmtInt,
  formatINR,
  Kpi,
  KpiGrid,
  ORDER_TYPE_LABEL,
  PAYMENT_LABEL,
  ReportBody,
  Section,
  ShareList,
  useReport,
} from "@/components/reports/shared";
import type { GroupBy, GstReport, SalesReport } from "@/components/reports/types";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";
import { Badge } from "@/components/ui/Badge";

type Metric = "gross" | "orders" | "aov";

const periodLabel = (p: string, g: GroupBy) => {
  if (g === "month") return new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  const d = new Date(`${p}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return g === "week" ? `Wk ${d}` : d;
};

export default function SalesReportPage() {
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [metric, setMetric] = useState<Metric>("gross");
  const report = useReport<SalesReport>("sales", { groupBy });
  // Cancelled bill details come from the GST report's cancelled-invoice register.
  const gst = useReport<GstReport>("gst");

  return (
    <>
      <PageHeader title="Sales" subtitle="Paid bills; tax, discounts and cancellations for the selected period." />
      <ReportToolbar exports={[{ path: "/reports/sales", query: { from: report.from, to: report.to, groupBy } }]}>
        <Segmented
          size="sm"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
      </ReportToolbar>
      <ReportBody state={report}>
        {(r) => (
          <div className="space-y-5">
            <KpiGrid>
              <Kpi label="Gross sales" value={formatINR(r.totals.gross)} note={`Net ${formatINR(r.totals.net)} · GST ${formatINR(r.totals.tax)}`} />
              <Kpi label="Orders" value={fmtInt(r.totals.orders)} note={`${fmtInt(r.periods.filter((p) => p.orders > 0).length)} trading ${groupBy}s`} />
              <Kpi label="Avg. order value" value={formatINR(r.totals.aov)} />
              <Kpi
                label="Discounts"
                value={formatINR(r.totals.discounts + r.totals.promoDiscounts)}
                note={`Manual ${formatINR(r.totals.discounts)} · Promo ${formatINR(r.totals.promoDiscounts)}`}
              />
              <Kpi label="Charges" value={formatINR(r.totals.extraCharges + r.totals.serviceCharge)} note={`Service ${formatINR(r.totals.serviceCharge)} · Extra ${formatINR(r.totals.extraCharges)}`} />
              <Kpi label="Round-off" value={formatINR(r.totals.roundOff)} />
              <Kpi label="Cancelled bills" value={fmtInt(r.totals.cancelled)} tone={r.totals.cancelled ? "bad" : undefined} note={`Value ${formatINR(r.totals.cancelledValue)}`} />
              <Kpi label="Net sales (ex-GST)" value={formatINR(r.totals.net)} />
            </KpiGrid>

            <Section
              title="Sales trend"
              subtitle={`By ${groupBy}`}
              action={
                <Segmented
                  size="sm"
                  value={metric}
                  onChange={setMetric}
                  options={[
                    { value: "gross", label: "Gross" },
                    { value: "orders", label: "Orders" },
                    { value: "aov", label: "AOV" },
                  ]}
                />
              }
            >
              <div className="p-4">
                {r.totals.orders === 0 ? (
                  <EmptyState title="No paid bills in this period" />
                ) : (
                  <ColumnChart
                    data={r.periods}
                    xKey="period"
                    yKey={metric}
                    kind={metric === "orders" ? "int" : "money"}
                    xFormat={(p) => periodLabel(p, r.groupBy)}
                    label={`Bar chart of ${metric} by ${groupBy}`}
                    tooltipExtra={(p) => [
                      ...(metric !== "orders" ? [{ label: "Orders", value: fmtInt(p.orders) }] : [{ label: "Gross", value: formatINR(p.gross) }]),
                      ...(p.cancelled ? [{ label: "Cancelled", value: fmtInt(p.cancelled) }] : []),
                    ]}
                  />
                )}
              </div>
            </Section>

            <div className="grid gap-5 lg:grid-cols-2">
              <Section title="Order types">
                <ShareList
                  rows={r.byOrderType.map((t) => ({ label: ORDER_TYPE_LABEL[t.orderType] ?? t.orderType, value: t.gross, count: t.orders, share: t.share }))}
                  countLabel={["order", "orders"]}
                />
              </Section>
              <Section title="Payment modes">
                <ShareList
                  rows={r.byPaymentMode.map((m) => ({ label: PAYMENT_LABEL[m.mode] ?? m.mode, value: m.amount, count: m.count, share: m.share }))}
                  countLabel={["payment", "payments"]}
                />
              </Section>
            </div>

            {r.byChannel && r.byChannel.some((c) => c.channel !== "POS") && (
              <Section title="Channels" subtitle="Commission is an estimate from the % set in Settings → Channels">
                <Table>
                  <THead>
                    <tr>
                      <Th>Channel</Th>
                      <Th className="text-right">Orders</Th>
                      <Th className="text-right">Gross</Th>
                      <Th className="text-right">Share</Th>
                      <Th className="text-right">Commission (est.)</Th>
                      <Th className="text-right">After commission</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.byChannel.map((c) => (
                      <tr key={c.channel}>
                        <Td className="font-semibold">{c.label}</Td>
                        <Td className="tabular text-right">{fmtInt(c.orders)}</Td>
                        <Td className="tabular text-right">{formatINR(c.gross)}</Td>
                        <Td className="tabular text-right">{c.share}%</Td>
                        <Td className="tabular text-right">{c.commissionPercent ? `${formatINR(c.commission)} (${c.commissionPercent}%)` : "—"}</Td>
                        <Td className="tabular text-right font-semibold">{formatINR(c.afterCommission)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Section>
            )}

            <Section title="Period breakdown">
              <Table>
                <THead>
                  <tr>
                    <Th>{groupBy === "day" ? "Date" : groupBy === "week" ? "Week of" : "Month"}</Th>
                    <Th className="text-right">Orders</Th>
                    <Th className="text-right">Gross</Th>
                    <Th className="text-right">Discounts</Th>
                    <Th className="text-right">Tax</Th>
                    <Th className="text-right">Net</Th>
                    <Th className="text-right">AOV</Th>
                    <Th className="text-right">Cancelled</Th>
                  </tr>
                </THead>
                <tbody>
                  {[...r.periods].reverse().map((p) => (
                    <tr key={p.period} className={p.orders === 0 ? "text-muted" : undefined}>
                      <Td className="font-semibold">{periodLabel(p.period, r.groupBy)}</Td>
                      <Td className="tabular text-right">{fmtInt(p.orders)}</Td>
                      <Td className="tabular text-right font-bold">{formatINR(p.gross)}</Td>
                      <Td className="tabular text-right">{formatINR(p.discounts + p.promoDiscounts)}</Td>
                      <Td className="tabular text-right">{formatINR(p.tax)}</Td>
                      <Td className="tabular text-right">{formatINR(p.net)}</Td>
                      <Td className="tabular text-right">{formatINR(p.aov)}</Td>
                      <Td className="tabular text-right">{p.cancelled ? `${p.cancelled} · ${formatINR(p.cancelledValue)}` : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>

            <Section title="Cancelled bills" subtitle="Voided invoices in this period with the reason recorded">
              {gst.loading && !gst.data ? (
                <p className="p-5 text-sm text-muted">Loading…</p>
              ) : gst.error ? (
                <p className="p-5 text-sm text-red-600">{gst.error}</p>
              ) : !gst.data?.cancelledInvoices.length ? (
                <EmptyState title="No cancelled bills" />
              ) : (
                <div className="max-h-[420px] overflow-y-auto">
                  <Table>
                    <THead>
                      <tr>
                        <Th>Invoice</Th>
                        <Th>Date</Th>
                        <Th>Reason</Th>
                        <Th className="text-right">Value</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {[...gst.data.cancelledInvoices].reverse().map((c) => (
                        <tr key={c.invoiceNumber}>
                          <Td className="font-mono text-xs font-semibold">{c.invoiceNumber}</Td>
                          <Td className="whitespace-nowrap">{c.date}</Td>
                          <Td className="text-muted">{c.reason || <Badge>No reason</Badge>}</Td>
                          <Td className="tabular text-right font-bold">{formatINR(c.value)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </Section>
          </div>
        )}
      </ReportBody>
    </>
  );
}
