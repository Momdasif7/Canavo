"use client";

import { PageHeader } from "@/components/layout/PageHeader";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, formatINR, Kpi, KpiGrid, Notes, ReportBody, Section, useReport } from "@/components/reports/shared";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";

interface Row {
  key: string;
  meals: number;
  gross: number;
  employerShare: number;
  employeeShare: number;
  walletSpend: number;
  tokensRedeemed: number;
  tokenValue: number;
}

interface CanteenReport {
  totals: Row;
  byAccount: Row[];
  byDepartment: Row[];
  liability: { members: number; walletBalance: number; tokensOutstanding: number; tokenValue: number };
  topups: { byMode: Record<string, { count: number; amount: number }>; wallet: number; tokensSold: number; tokenSales: number };
}

function RowsTable({ rows, first }: { rows: Row[]; first: string }) {
  if (!rows.length) return <EmptyState title="No canteen meals in this period" />;
  return (
    <Table>
      <THead>
        <tr>
          <Th>{first}</Th>
          <Th className="text-right">Meals</Th>
          <Th className="text-right">Gross</Th>
          <Th className="text-right">Company share</Th>
          <Th className="text-right">Employee share</Th>
          <Th className="text-right">Wallet</Th>
          <Th className="text-right">Tokens</Th>
        </tr>
      </THead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <Td className="font-semibold">{r.key}</Td>
            <Td className="tabular text-right">{fmtInt(r.meals)}</Td>
            <Td className="tabular text-right">{formatINR(r.gross)}</Td>
            <Td className="tabular text-right">{formatINR(r.employerShare)}</Td>
            <Td className="tabular text-right">{formatINR(r.employeeShare)}</Td>
            <Td className="tabular text-right">{formatINR(r.walletSpend)}</Td>
            <Td className="tabular text-right">{fmtInt(r.tokensRedeemed)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Reports → Canteen (Phase 5.5): meals by company and department, who paid, and prepaid balances. */
export default function CanteenReportPage() {
  // Hotels without the Canteen module get 403 "not enabled", shown as the module-off state.
  const report = useReport<CanteenReport>("canteen");
  return (
    <>
      <PageHeader title="Canteen" subtitle="Members' paid meals by company and department: what the company pays, what employees pay, wallet and meal tokens." />
      <ReportToolbar exports={[{ path: "/reports/canteen", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => (
          <div className="space-y-5">
            <KpiGrid cols={6}>
              <Kpi label="Meals" value={fmtInt(r.totals.meals)} note={formatINR(r.totals.gross)} />
              <Kpi label="Company share" value={formatINR(r.totals.employerShare)} note="Billed on statements" />
              <Kpi label="Employee share" value={formatINR(r.totals.employeeShare)} />
              <Kpi label="Paid by wallet" value={formatINR(r.totals.walletSpend)} />
              <Kpi label="Tokens used" value={fmtInt(r.totals.tokensRedeemed)} note={formatINR(r.totals.tokenValue)} />
              <Kpi label="Wallet top-ups" value={formatINR(r.topups.wallet)} note={`${fmtInt(r.topups.tokensSold)} tokens sold · ${formatINR(r.topups.tokenSales)}`} />
            </KpiGrid>

            <Section title="By company">
              <RowsTable rows={r.byAccount} first="Company" />
            </Section>
            <Section title="By department">
              <RowsTable rows={r.byDepartment} first="Company · department" />
            </Section>
            <Section title="Prepaid balances (now, all outlets)">
              <div className="p-4">
                <KpiGrid cols={3}>
                  <Kpi label="Wallet balances" value={formatINR(r.liability.walletBalance)} note={`${fmtInt(r.liability.members)} members`} />
                  <Kpi label="Meal tokens not used" value={fmtInt(r.liability.tokensOutstanding)} note={formatINR(r.liability.tokenValue)} />
                  <Kpi label="Total owed to members" value={formatINR(r.liability.walletBalance + r.liability.tokenValue)} />
                </KpiGrid>
              </div>
            </Section>
            <Notes
              notes={[
                "Bills are issued to the employee at full price with GST; the company's share is a payment on the bill, not a discount.",
                "Wallet top-ups and meal tokens are prepaid money (a liability), not sales: no GST until they pay for a meal.",
              ]}
            />
          </div>
        )}
      </ReportBody>
    </>
  );
}
