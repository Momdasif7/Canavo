"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, formatINR, Kpi, KpiGrid, Notes, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { GstReport } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert, EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

const DOC_LABEL: Record<string, string> = { TAX_INVOICE: "Tax invoice", BILL_OF_SUPPLY: "Bill of supply" };

export default function GstReportPage() {
  const report = useReport<GstReport>("gst");
  const [showCancelled, setShowCancelled] = useState(false);

  return (
    <>
      <PageHeader
        title="GST summary"
        subtitle="Output tax by rate for your returns. Only paid invoices count as supplies."
        actions={
          <Link href="/reports/gstr1" className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2">
            GSTR-1 return <ArrowRight size={18} />
          </Link>
        }
      />
      <ReportToolbar exports={[{ path: "/reports/gst", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={r.gstin ? "info" : "warning"}>GSTIN {r.gstin ?? "not set"}</Badge>
              <Badge>State code {r.stateCode}</Badge>
              {r.compositionScheme && <Badge tone="warning">Composition scheme</Badge>}
            </div>
            {!r.gstin && <Alert tone="warning">Set the outlet GSTIN in Settings before filing returns.</Alert>}

            <KpiGrid cols={6}>
              <Kpi label="Taxable value" value={formatINR(r.totals.taxable)} />
              <Kpi label="CGST" value={formatINR(r.totals.cgst)} />
              <Kpi label="SGST" value={formatINR(r.totals.sgst)} />
              <Kpi label="IGST" value={formatINR(r.totals.igst)} />
              <Kpi label="Total GST" value={formatINR(r.totals.totalTax)} />
              <Kpi label="Invoice value" value={formatINR(r.totals.invoiceValue)} note={`Round-off ${formatINR(r.totals.roundOff)}`} />
            </KpiGrid>

            {r.billOfSupplyTurnover > 0 && (
              <Alert tone="info">Bill of supply turnover (no GST charged): {formatINR(r.billOfSupplyTurnover)}</Alert>
            )}

            <Section title="By rate" subtitle="Intra-state supplies split into CGST + SGST; inter-state charge IGST">
              {r.byRate.length === 0 ? (
                <EmptyState title="No taxable supplies in this period" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Rate</Th>
                      <Th>Supply</Th>
                      <Th className="text-right">Invoices</Th>
                      <Th className="text-right">Taxable</Th>
                      <Th className="text-right">CGST</Th>
                      <Th className="text-right">SGST</Th>
                      <Th className="text-right">IGST</Th>
                      <Th className="text-right">Total tax</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.byRate.map((b) => (
                      <tr key={`${b.rate}-${b.supply}`}>
                        <Td className="font-bold">{b.rate}%</Td>
                        <Td>
                          <Badge tone={b.supply === "INTER" ? "warning" : "neutral"}>{b.supply === "INTER" ? "Inter-state" : "Intra-state"}</Badge>
                        </Td>
                        <Td className="tabular text-right">{fmtInt(b.invoices)}</Td>
                        <Td className="tabular text-right font-semibold">{formatINR(b.taxable)}</Td>
                        <Td className="tabular text-right">{formatINR(b.cgst)}</Td>
                        <Td className="tabular text-right">{formatINR(b.sgst)}</Td>
                        <Td className="tabular text-right">{formatINR(b.igst)}</Td>
                        <Td className="tabular text-right font-bold">{formatINR(b.totalTax)}</Td>
                      </tr>
                    ))}
                    <tr className="bg-surface-2/60 font-bold">
                      <Td colSpan={3}>Total</Td>
                      <Td className="tabular text-right">{formatINR(r.totals.taxable)}</Td>
                      <Td className="tabular text-right">{formatINR(r.totals.cgst)}</Td>
                      <Td className="tabular text-right">{formatINR(r.totals.sgst)}</Td>
                      <Td className="tabular text-right">{formatINR(r.totals.igst)}</Td>
                      <Td className="tabular text-right">{formatINR(r.totals.totalTax)}</Td>
                    </tr>
                  </tbody>
                </Table>
              )}
            </Section>

            <Section title="Documents issued">
              {r.documentTypes.length === 0 ? (
                <EmptyState title="No documents issued" />
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Document type</Th>
                      <Th className="text-right">Issued</Th>
                      <Th className="text-right">Paid</Th>
                      <Th className="text-right">Open</Th>
                      <Th className="text-right">Cancelled</Th>
                      <Th className="text-right">Paid value</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {r.documentTypes.map((d) => (
                      <tr key={d.documentType}>
                        <Td className="font-semibold">{DOC_LABEL[d.documentType] ?? d.documentType}</Td>
                        <Td className="tabular text-right">{fmtInt(d.issued)}</Td>
                        <Td className="tabular text-right">{fmtInt(d.paid)}</Td>
                        <Td className="tabular text-right">{d.open ? <Badge tone="warning">{d.open}</Badge> : 0}</Td>
                        <Td className="tabular text-right">{d.cancelled ? <Badge tone="danger">{d.cancelled}</Badge> : 0}</Td>
                        <Td className="tabular text-right font-bold">{formatINR(d.value)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>

            <Section
              title="Cancelled invoices"
              subtitle={`${r.cancelledInvoices.length} in this period · ${formatINR(r.cancelledInvoices.reduce((s, c) => s + c.value, 0))}`}
              action={
                r.cancelledInvoices.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowCancelled((s) => !s)} aria-expanded={showCancelled}>
                    {showCancelled ? "Hide" : "Show"}
                  </Button>
                )
              }
            >
              {r.cancelledInvoices.length === 0 ? (
                <EmptyState title="No cancelled invoices" />
              ) : showCancelled ? (
                <div className="max-h-[420px] overflow-y-auto">
                  <Table>
                    <THead>
                      <tr>
                        <Th>Invoice</Th>
                        <Th>Type</Th>
                        <Th>Date</Th>
                        <Th>Reason</Th>
                        <Th className="text-right">Value</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.cancelledInvoices.map((c) => (
                        <tr key={c.invoiceNumber}>
                          <Td className="font-mono text-xs font-semibold">{c.invoiceNumber}</Td>
                          <Td>{DOC_LABEL[c.documentType] ?? c.documentType}</Td>
                          <Td className="whitespace-nowrap">{c.date}</Td>
                          <Td className="text-muted">{c.reason || "—"}</Td>
                          <Td className="tabular text-right">{formatINR(c.value)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : null}
            </Section>

            <Notes notes={r.notes} />
          </div>
        )}
      </ReportBody>
    </>
  );
}
