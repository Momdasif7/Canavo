"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtMin, fmtNum, fmtPct, formatINR, Kpi, KpiGrid, Notes, ReportBody, Section, ShareList, useReport } from "@/components/reports/shared";
import type { DeliveryAgentRow, DeliveryReport } from "@/components/reports/types";
import { titleCase } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

export default function DeliveryReportPage() {
  const report = useReport<DeliveryReport>("delivery");
  return (
    <>
      <PageHeader title="Delivery" subtitle="Delivery volume, speed and per-agent performance." />
      <ReportToolbar exports={[{ path: "/reports/delivery", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) =>
          r.deliveries === 0 ? (
            <EmptyState title="No deliveries in this period" />
          ) : (
            <div className="space-y-5">
              <KpiGrid>
                <Kpi label="Delivery orders" value={fmtInt(r.deliveries)} note={`${fmtInt(r.delivered)} delivered · ${fmtInt(r.cancelled)} cancelled`} />
                <Kpi label="Avg delivery time" value={fmtMin(r.avgDeliveryMinutes)} note="Assigned → delivered" />
                <Kpi label="Order to door" value={fmtMin(r.avgOrderToDeliveryMinutes)} note="Order created → delivered" />
                <Kpi
                  label="On time"
                  value={fmtPct(r.onTimePercent)}
                  tone={r.onTimePercent == null ? undefined : r.onTimePercent >= 85 ? "good" : r.onTimePercent < 70 ? "warn" : undefined}
                  note={`${formatINR(r.value)} delivered · ${fmtNum(r.distanceKm, 1)} km`}
                />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
                <Section title="Delivered by agent">
                  <div className="p-4">
                    <RankedBars
                      data={r.agents}
                      nameKey="agent"
                      valueKey="delivered"
                      kind="int"
                      label="Bar chart of deliveries completed per agent"
                      extra={(a: DeliveryAgentRow) => [
                        { label: "Avg", value: fmtMin(a.avgDeliveryMinutes) },
                        { label: "On time", value: fmtPct(a.onTimePercent) },
                      ]}
                    />
                  </div>
                </Section>
                <Section title="By status">
                  <ShareList
                    rows={Object.entries(r.byStatus)
                      .sort((a, b) => b[1] - a[1])
                      .map(([status, count]) => ({ label: titleCase(status), value: count }))}
                    valueFormat={fmtInt}
                  />
                </Section>
              </div>

              <Section title="Agents">
                <Table>
                  <THead>
                    <tr>
                      <Th>Agent</Th>
                      <Th className="text-right">Orders</Th>
                      <Th className="text-right">Delivered</Th>
                      <Th className="text-right">Cancelled</Th>
                      <Th className="text-right">Value</Th>
                      <Th className="text-right">Avg time</Th>
                      <Th className="text-right">On time</Th>
                      <Th className="text-right">Distance</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.agents.map((a) => (
                      <tr key={a.agentId}>
                        <Td className="font-semibold">{a.agent}</Td>
                        <Td className="tabular text-right">{fmtInt(a.deliveries)}</Td>
                        <Td className="tabular text-right">{fmtInt(a.delivered)}</Td>
                        <Td className="tabular text-right">{a.cancelled ? <Badge tone="danger">{a.cancelled}</Badge> : "—"}</Td>
                        <Td className="tabular text-right font-bold">{formatINR(a.value)}</Td>
                        <Td className="tabular text-right">{fmtMin(a.avgDeliveryMinutes)}</Td>
                        <Td className="tabular text-right">{fmtPct(a.onTimePercent)}</Td>
                        <Td className="tabular text-right">{fmtNum(a.distanceKm, 1)} km</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Section>
              <Notes notes={r.notes} />
            </div>
          )
        }
      </ReportBody>
    </>
  );
}
