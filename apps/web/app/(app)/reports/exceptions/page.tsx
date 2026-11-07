"use client";

import { REFUND_REASON_LABELS } from "@canavo/shared";
import { PageHeader } from "@/components/layout/PageHeader";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, formatINR, Kpi, KpiGrid, ReportBody, Section, useReport } from "@/components/reports/shared";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";

interface ExceptionsReport {
  discountLimitPercent: number;
  totals: {
    voids: { count: number; amount: number; afterPayment: number };
    refunds: { count: number; amount: number };
    bigDiscounts: { count: number; amount: number };
    approvals: number;
    unapproved: number;
    reprints: number;
  };
  voids: { invoiceNumber: string; at: string; amount: number; reason: string; wasPaid: boolean; cashier: string; by: string }[];
  refunds: { number: string; invoiceNumber: string; at: string; amount: number; reason: string; note: string; mode: string; by: string; approvedBy: string }[];
  bigDiscounts: { invoiceNumber: string; at: string; subtotal: number; discount: number; percent: number; cashier: string }[];
  approvals: { at: string; action: string; amount: number; reason: string; requestedBy: string; approvedBy: string }[];
  reprints: { at: string; kot: string; by: string }[];
}

const ACTION_LABEL: Record<string, string> = { DISCOUNT: "Discount", VOID: "Void", REFUND: "Refund", CASH_PAYOUT: "Cash pay-out" };

/** Reports → Exceptions (Phase 3.3): everything that takes money off a bill or needs a second look. */
export default function ExceptionsPage() {
  const report = useReport<ExceptionsReport>("exceptions");
  return (
    <>
      <PageHeader title="Exceptions" subtitle="Voids, refunds, big discounts, manager approvals and KOT reprints — check these daily." />
      <ReportToolbar exports={[{ path: "/reports/exceptions", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => (
          <div className="space-y-5">
            <KpiGrid cols={6}>
              <Kpi label="Voided bills" value={fmtInt(r.totals.voids.count)} note={`${formatINR(r.totals.voids.amount)} · ${r.totals.voids.afterPayment} after payment`} />
              <Kpi label="Refunds" value={fmtInt(r.totals.refunds.count)} note={formatINR(r.totals.refunds.amount)} />
              <Kpi label={`Discounts > ${r.discountLimitPercent}%`} value={fmtInt(r.totals.bigDiscounts.count)} note={formatINR(r.totals.bigDiscounts.amount)} />
              <Kpi label="Approvals" value={fmtInt(r.totals.approvals)} />
              <Kpi label="Not approved (offline)" value={fmtInt(r.totals.unapproved)} />
              <Kpi label="KOT reprints" value={fmtInt(r.totals.reprints)} />
            </KpiGrid>

            <Section title="Voided bills">
              {r.voids.length === 0 ? (
                <EmptyState title="No voids in this period" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Bill</Th>
                      <Th>Voided</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Reason</Th>
                      <Th>Billed by</Th>
                      <Th>Voided by</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.voids.map((v) => (
                      <tr key={v.invoiceNumber}>
                        <Td className="font-semibold">
                          {v.invoiceNumber} {v.wasPaid && <Badge tone="danger">was paid</Badge>}
                        </Td>
                        <Td className="whitespace-nowrap text-muted">{v.at}</Td>
                        <Td className="tabular text-right">{formatINR(v.amount)}</Td>
                        <Td>{v.reason}</Td>
                        <Td>{v.cashier}</Td>
                        <Td>{v.by}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>

            <Section title="Refunds (credit notes)">
              {r.refunds.length === 0 ? (
                <EmptyState title="No refunds in this period" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Credit note</Th>
                      <Th>Bill</Th>
                      <Th>Issued</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Mode</Th>
                      <Th>Reason</Th>
                      <Th>By / approved by</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.refunds.map((x) => (
                      <tr key={x.number}>
                        <Td className="font-semibold">{x.number}</Td>
                        <Td>{x.invoiceNumber}</Td>
                        <Td className="whitespace-nowrap text-muted">{x.at}</Td>
                        <Td className="tabular text-right">{formatINR(x.amount)}</Td>
                        <Td>{x.mode.toLowerCase()}</Td>
                        <Td>
                          {REFUND_REASON_LABELS[x.reason as keyof typeof REFUND_REASON_LABELS] ?? x.reason}
                          {x.note && <span className="block text-xs text-muted">{x.note}</span>}
                        </Td>
                        <Td>
                          {x.by}
                          {x.approvedBy && x.approvedBy !== x.by && <span className="block text-xs text-muted">approved by {x.approvedBy}</span>}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>

            <Section title={`Discounts above ${r.discountLimitPercent}%`}>
              {r.bigDiscounts.length === 0 ? (
                <EmptyState title="No large discounts" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Bill</Th>
                      <Th>Billed</Th>
                      <Th className="text-right">Subtotal</Th>
                      <Th className="text-right">Discount</Th>
                      <Th>Cashier</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.bigDiscounts.map((d) => (
                      <tr key={d.invoiceNumber}>
                        <Td className="font-semibold">{d.invoiceNumber}</Td>
                        <Td className="whitespace-nowrap text-muted">{d.at}</Td>
                        <Td className="tabular text-right">{formatINR(d.subtotal)}</Td>
                        <Td className="tabular text-right">
                          {formatINR(d.discount)} <span className="text-xs text-muted">({d.percent}%)</span>
                        </Td>
                        <Td>{d.cashier}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>

            <Section title="Manager approvals" subtitle="Turn on “Manager approval PINs” for your hotel to require these.">
              {r.approvals.length === 0 ? (
                <EmptyState title="No approvals in this period" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>When</Th>
                      <Th>Action</Th>
                      <Th className="text-right">Amount</Th>
                      <Th>Requested by</Th>
                      <Th>Approved by</Th>
                      <Th>Reason</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.approvals.map((a, i) => (
                      <tr key={i}>
                        <Td className="whitespace-nowrap text-muted">{a.at}</Td>
                        <Td>{ACTION_LABEL[a.action] ?? a.action}</Td>
                        <Td className="tabular text-right">{formatINR(a.amount)}</Td>
                        <Td>{a.requestedBy}</Td>
                        <Td>{a.approvedBy.startsWith("NOT") ? <Badge tone="warning">Not approved (offline)</Badge> : a.approvedBy}</Td>
                        <Td>{a.reason}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>

            {r.reprints.length > 0 && (
              <Section title="KOT reprints">
                <ul className="divide-y divide-line text-sm">
                  {r.reprints.map((p, i) => (
                    <li key={i} className="flex justify-between px-4 py-2">
                      <span className="text-muted">{p.at}</span>
                      <span>{p.by}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        )}
      </ReportBody>
    </>
  );
}
