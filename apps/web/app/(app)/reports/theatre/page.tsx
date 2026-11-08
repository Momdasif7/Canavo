"use client";

import { SEAT_TIMING_LABELS } from "@canavo/shared";
import { PageHeader } from "@/components/layout/PageHeader";
import { RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { CellBar, fmtInt, formatINR, Kpi, KpiGrid, ReportBody, Section, ShareList, useReport } from "@/components/reports/shared";
import type { TheatreReport } from "@/lib/theatre";
import { useSession } from "@/components/providers/SessionProvider";
import { EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

/** Reports → Cinema: seat-order sales by screen, show and timing (THEATRE module). */
export default function TheatreReportPage() {
  const { outlet } = useSession();
  const tz = outlet?.timezone;
  const report = useReport<TheatreReport>("theatre");
  const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
  return (
    <>
      <PageHeader title="Cinema" subtitle="Food ordered from seat QR codes: by screen, by show and by when guests wanted it." />
      <ReportToolbar exports={[{ path: "/reports/theatre", query: { from: report.from, to: report.to }, filename: `theatre_${report.from}_${report.to}` }]} />
      <ReportBody state={report}>
        {(r) =>
          r.totals.orders === 0 ? (
            <EmptyState title="No seat orders in this period" description="Orders placed from seat QR codes show up here once they are paid." />
          ) : (
            <div className="space-y-5" data-testid="theatre-report">
              <KpiGrid cols={3}>
                <Kpi label="Seat orders" value={fmtInt(r.totals.orders)} />
                <Kpi label="Sales" value={formatINR(r.totals.sales)} />
                <Kpi label="Average order" value={formatINR(r.totals.avgOrder)} />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
                <Section title="Sales by screen">
                  <div className="p-4">
                    <RankedBars
                      data={r.byScreen}
                      nameKey="name"
                      valueKey="sales"
                      kind="money"
                      label="Bar chart of seat-order sales per screen"
                      extra={(s) => [{ label: "Orders", value: fmtInt(s.orders) }]}
                    />
                  </div>
                </Section>
                <Section title="When guests wanted it">
                  <ShareList
                    rows={[...r.byTiming].sort((a, b) => b.sales - a.sales).map((t) => ({ label: SEAT_TIMING_LABELS[t.timing], value: t.sales, count: t.orders }))}
                    countLabel={["order", "orders"]}
                  />
                </Section>
              </div>

              <Section title="By show" subtitle="Which shows sell the most food.">
                {r.byShow.length === 0 ? (
                  <EmptyState title="No show in this period" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <Th>Show</Th>
                        <Th>Screen</Th>
                        <Th>Starts</Th>
                        <Th className="text-right">Orders</Th>
                        <Th className="text-right">Sales</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {[...r.byShow]
                        .sort((a, b) => b.sales - a.sales)
                        .map((s) => {
                          const max = Math.max(...r.byShow.map((x) => x.sales));
                          return (
                            <tr key={s.showTimeId}>
                              <Td className="font-semibold">{s.title}</Td>
                              <Td>{s.screenName}</Td>
                              <Td className="tabular whitespace-nowrap">{when(s.startsAt)}</Td>
                              <Td className="tabular text-right">{fmtInt(s.orders)}</Td>
                              <Td className="tabular text-right font-bold">
                                {formatINR(s.sales)}
                                <div className="flex justify-end">
                                  <CellBar value={s.sales} max={max} />
                                </div>
                              </Td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </Table>
                )}
              </Section>
            </div>
          )
        }
      </ReportBody>
    </>
  );
}
