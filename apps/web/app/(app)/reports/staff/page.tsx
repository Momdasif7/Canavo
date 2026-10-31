"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtNum, formatINR, Kpi, KpiGrid, Notes, ReportBody, roleLabel, Section, useReport } from "@/components/reports/shared";
import type { StaffReport, StaffRow } from "@/components/reports/types";
import { formatMinutes } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

export default function StaffReportPage() {
  const report = useReport<StaffReport>("staff");
  return (
    <>
      <PageHeader title="Staff performance" subtitle="Billing per cashier and attendance for the period." />
      <ReportToolbar exports={[{ path: "/reports/staff", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => {
          const billers = r.staff.filter((s) => s.bills || s.cancellations);
          const totalBills = billers.reduce((s, x) => s + x.bills, 0);
          const totalSales = billers.reduce((s, x) => s + x.sales, 0);
          const totalLate = r.staff.reduce((s, x) => s + x.lateCount, 0);
          const totalPay = r.staff.reduce((s, x) => s + x.estimatedPay, 0);
          return (
            <div className="space-y-5">
              <KpiGrid>
                <Kpi label="Bills raised" value={fmtInt(totalBills)} note={`${billers.length} staff billed`} />
                <Kpi label="Sales billed" value={formatINR(totalSales)} />
                <Kpi label="Late arrivals" value={fmtInt(totalLate)} tone={totalLate ? "warn" : undefined} />
                <Kpi label="Estimated payroll" value={formatINR(totalPay)} note="Pro-rated for the period" />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-[2fr_3fr]">
                <Section title="Sales by cashier">
                  <div className="p-4">
                    {billers.length === 0 ? (
                      <EmptyState title="No bills in this period" />
                    ) : (
                      <RankedBars
                        data={billers}
                        nameKey="name"
                        valueKey="sales"
                        kind="money"
                        label="Bar chart of sales per cashier"
                        extra={(s: StaffRow) => [
                          { label: "Bills", value: fmtInt(s.bills) },
                          { label: "Avg", value: formatINR(s.avgBill) },
                        ]}
                      />
                    )}
                  </div>
                </Section>
                <Section title="Billing">
                  {billers.length === 0 ? (
                    <EmptyState title="No bills in this period" />
                  ) : (
                    <Table>
                      <THead>
                        <tr>
                          <Th>Name</Th>
                          <Th className="text-right">Bills</Th>
                          <Th className="text-right">Sales</Th>
                          <Th className="text-right">Avg bill</Th>
                          <Th className="text-right">Cancelled</Th>
                        </tr>
                      </THead>
                      <tbody>
                        {billers.map((s) => (
                          <tr key={s.userId}>
                            <Td>
                              <p className="font-semibold">{s.name}</p>
                              <p className="text-xs text-muted">{roleLabel(s.role)}</p>
                            </Td>
                            <Td className="tabular text-right">{fmtInt(s.bills)}</Td>
                            <Td className="tabular text-right font-bold">{formatINR(s.sales)}</Td>
                            <Td className="tabular text-right">{formatINR(s.avgBill)}</Td>
                            <Td className="tabular text-right">
                              {s.cancellations ? (
                                <Badge tone={s.bills && s.cancellations / s.bills > 0.05 ? "danger" : "warning"}>
                                  {s.cancellations} · {formatINR(s.cancelledValue)}
                                </Badge>
                              ) : (
                                "—"
                              )}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Section>
              </div>

              <Section title="Attendance & pay">
                {r.staff.length === 0 ? (
                  <EmptyState title="No staff assigned to this outlet" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <Th>Name</Th>
                        <Th className="text-right">Present</Th>
                        <Th className="text-right">Half days</Th>
                        <Th className="text-right">Paid leave</Th>
                        <Th className="text-right">Late</Th>
                        <Th className="text-right">Overtime</Th>
                        <Th className="text-right">Hours</Th>
                        <Th className="text-right">Payable days</Th>
                        <Th className="text-right">Est. pay</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.staff.map((s) => (
                        <tr key={s.userId}>
                          <Td>
                            <p className="font-semibold">{s.name}</p>
                            <p className="text-xs text-muted">{roleLabel(s.role)}</p>
                          </Td>
                          <Td className="tabular text-right">{s.presentDays}</Td>
                          <Td className="tabular text-right">{s.halfDays}</Td>
                          <Td className="tabular text-right">{s.paidLeaveDays}</Td>
                          <Td className="tabular text-right">
                            {s.lateCount ? (
                              <Badge tone="warning">
                                {s.lateCount}× · {formatMinutes(s.lateMinutes)}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </Td>
                          <Td className="tabular text-right">{s.overtimeMinutes ? formatMinutes(s.overtimeMinutes) : "—"}</Td>
                          <Td className="tabular text-right">{fmtNum(s.workedHours, 1)}</Td>
                          <Td className="tabular text-right">{fmtNum(s.payableDays, 1)}</Td>
                          <Td className="tabular text-right font-bold">{formatINR(s.estimatedPay)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Section>
              <Notes notes={r.notes} />
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}
