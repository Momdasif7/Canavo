"use client";

import { Coins, Notebook } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Donut } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtPct, formatINR, Kpi, KpiGrid, Notes, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { CustomersReport } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

const LIMIT = 10;

export default function CustomersReportPage() {
  const report = useReport<CustomersReport>("customers", { limit: LIMIT });
  return (
    <>
      <PageHeader title="Customers" subtitle="Who comes back, how much they spend, loyalty and khata." />
      <ReportToolbar exports={[{ path: "/reports/customers", query: { from: report.from, to: report.to, limit: LIMIT } }]} />
      <ReportBody state={report}>
        {(r) => (
          <div className="space-y-5">
            <KpiGrid>
              <Kpi label="Known customers" value={fmtInt(r.uniqueCustomers)} note={`${fmtInt(r.newCustomers)} new · ${fmtInt(r.returningCustomers)} returning`} />
              <Kpi label="Repeat rate" value={fmtPct(r.repeatRate)} note={`${fmtInt(r.repeatCustomers)} with 2+ orders`} tone={r.repeatRate >= 40 ? "good" : undefined} />
              <Kpi
                label="Customer AOV"
                value={formatINR(r.customerAov)}
                note={`Overall ${formatINR(r.overallAov)}`}
                tone={r.customerAov > r.overallAov ? "good" : undefined}
              />
              <Kpi label="Identified orders" value={fmtPct(r.identifiedOrderShare)} note={`${fmtInt(r.customerOrders)} known · ${fmtInt(r.walkInOrders)} walk-in`} />
            </KpiGrid>

            <div className="grid gap-5 lg:grid-cols-3">
              <Section title="New vs returning" subtitle="Known customers with a paid order">
                {r.uniqueCustomers === 0 ? (
                  <EmptyState title="No identified customers" description="Attach a phone number at billing to track customers." />
                ) : (
                  <Donut
                    kind="int"
                    label="Donut chart of new versus returning customers"
                    slices={[
                      { label: "New", value: r.newCustomers },
                      { label: "Returning", value: r.returningCustomers },
                    ]}
                  />
                )}
              </Section>
              <Section title="Loyalty points" subtitle="Earned and redeemed on orders in this period">
                <dl className="divide-y divide-line">
                  <Row icon={<Coins size={18} />} label="Issued" value={fmtInt(r.pointsIssued)} />
                  <Row icon={<Coins size={18} />} label="Redeemed" value={fmtInt(r.pointsRedeemed)} />
                  <Row label="Redemption ratio" value={r.pointsIssued ? fmtPct((r.pointsRedeemed / r.pointsIssued) * 100) : "—"} />
                </dl>
              </Section>
              <Section title="Khata (credit)" subtitle="Given and collected this period">
                <dl className="divide-y divide-line">
                  <Row icon={<Notebook size={18} />} label="Given (debits)" value={formatINR(r.khataDebits)} />
                  <Row icon={<Notebook size={18} />} label="Collected (credits)" value={formatINR(r.khataCredits)} />
                  <Row
                    label={`Outstanding · ${r.khataCustomersWithDues} customer${r.khataCustomersWithDues === 1 ? "" : "s"}`}
                    value={<span className={r.khataOutstanding > 0 ? "text-red-600 dark:text-red-300" : undefined}>{formatINR(r.khataOutstanding)}</span>}
                    strong
                  />
                </dl>
              </Section>
            </div>

            <Section title="Top customers" subtitle={`Top ${LIMIT} by spend`}>
              {r.topCustomers.length === 0 ? (
                <EmptyState title="No identified customers in this period" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>#</Th>
                      <Th>Customer</Th>
                      <Th>Tier</Th>
                      <Th className="text-right">Orders</Th>
                      <Th className="text-right">Spend</Th>
                      <Th className="text-right">Avg order</Th>
                      <Th className="text-right">Points</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.topCustomers.map((c, i) => (
                      <tr key={c.customerId}>
                        <Td className="text-muted">{i + 1}</Td>
                        <Td>
                          <p className="font-semibold">{c.name || "Unnamed"}</p>
                          <p className="tabular text-xs text-muted">{c.phone}</p>
                        </Td>
                        <Td>{c.tier ? <Badge tone={c.tier === "GOLD" || c.tier === "PLATINUM" ? "warning" : "neutral"}>{c.tier}</Badge> : "—"}</Td>
                        <Td className="tabular text-right">{fmtInt(c.orders)}</Td>
                        <Td className="tabular text-right font-bold">{formatINR(c.spend)}</Td>
                        <Td className="tabular text-right">{formatINR(c.avgOrder)}</Td>
                        <Td className="tabular text-right">{fmtInt(c.points)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
            <Notes notes={r.notes} />
          </div>
        )}
      </ReportBody>
    </>
  );
}

function Row({ icon, label, value, strong }: { icon?: React.ReactNode; label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={strong ? "flex items-center justify-between gap-3 px-5 py-3 font-bold" : "flex items-center justify-between gap-3 px-5 py-3"}>
      <dt className={strong ? "flex items-center gap-2" : "flex items-center gap-2 text-muted"}>
        {icon}
        {label}
      </dt>
      <dd className="tabular font-bold">{value}</dd>
    </div>
  );
}
