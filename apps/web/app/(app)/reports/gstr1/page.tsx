"use client";

import { useState } from "react";
import { FileCode, FileXls, FilePdf, Warning } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { addDaysISO, monthLabel, todayISO } from "@/lib/dates";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { DownloadButton } from "@/components/reports/ExportButtons";
import { fmtInt, Kpi, KpiGrid, Notes, ReportBody, Section } from "@/components/reports/shared";
import type { Gstr1Response } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Alert, EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

/** GSTN amounts are rupees with 2 decimals. */
const rs = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export default function Gstr1Page() {
  const { outletId, outlet } = useSession();
  const today = todayISO(outlet?.timezone);
  const thisMonth = today.slice(0, 7);
  // Returns are filed for the month just ended.
  const [month, setMonth] = useState(addDaysISO(`${thisMonth}-01`, -1).slice(0, 7));
  const valid = MONTH_RE.test(month) && month <= thisMonth;
  const report = useApiQuery<Gstr1Response>(outletId && valid ? `gstr1:${outletId}:${month}` : null, () =>
    api.get<Gstr1Response>("/reports/gstr1", { query: { month } }),
  );
  const fp = `${month.slice(5, 7)}${month.slice(0, 4)}`;

  return (
    <>
      <PageHeader title="GSTR-1" subtitle="Outward supplies return (B2C small, HSN summary, documents issued) for upload to the GST portal." />
      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-surface p-3 shadow-sm">
        <Input
          label="Return period"
          type="month"
          value={month}
          max={thisMonth}
          onChange={(e) => setMonth(e.target.value)}
          error={valid ? null : "Pick a month up to the current one (YYYY-MM)"}
          className="min-h-[40px]"
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <DownloadButton
            path="/reports/gstr1"
            query={{ month, format: "json", download: 1 }}
            filename={`GSTR1_${fp}.json`}
            variant="primary"
            icon={<FileCode size={20} />}
          >
            Download GSTN JSON
          </DownloadButton>
          <DownloadButton path="/reports/gstr1" query={{ month, format: "xlsx" }} filename={`GSTR1_${fp}.xlsx`} icon={<FileXls size={20} />}>
            Excel
          </DownloadButton>
          <DownloadButton path="/reports/gstr1" query={{ month, format: "pdf" }} filename={`GSTR1_${fp}.pdf`} icon={<FilePdf size={20} />}>
            PDF
          </DownloadButton>
        </div>
      </div>

      {valid && (
        <ReportBody state={report}>
          {(r) => (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{monthLabel(r.month)}</Badge>
                <Badge>FY {r.financialYear}</Badge>
                <Badge>Period {r.gstr1.fp}</Badge>
                <Badge tone={r.gstr1.gstin ? "neutral" : "warning"}>GSTIN {r.gstr1.gstin || "not set"}</Badge>
              </div>

              {r.excluded && (
                <Alert tone="warning">
                  This outlet is under the composition scheme — GSTR-1 is not applicable. File CMP-08 quarterly and GSTR-4 annually.
                </Alert>
              )}

              {r.warnings.length > 0 && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10" role="status">
                  <p className="mb-2 flex items-center gap-2 font-bold text-amber-900 dark:text-amber-200">
                    <Warning size={20} weight="fill" /> Review before filing ({r.warnings.length})
                  </p>
                  <ul className="list-disc space-y-1 pl-6 text-sm text-amber-900 dark:text-amber-200">
                    {r.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <KpiGrid cols={4}>
                <Kpi label="Invoices" value={fmtInt(r.totals.invoices)} />
                <Kpi label="Taxable value" value={rs(r.totals.txval)} />
                <Kpi label="CGST + SGST" value={rs(r.totals.camt + r.totals.samt)} note={`CGST ${rs(r.totals.camt)} · SGST ${rs(r.totals.samt)}`} />
                <Kpi label="IGST" value={rs(r.totals.iamt)} />
              </KpiGrid>

              <Section title="B2CS — B2C small supplies" subtitle="Grouped by place of supply, rate and supply type">
                {r.gstr1.b2cs.length === 0 ? (
                  <EmptyState title="No B2C supplies in this period" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <Th>Supply</Th>
                        <Th>Place of supply</Th>
                        <Th>Type</Th>
                        <Th className="text-right">Rate</Th>
                        <Th className="text-right">Taxable value</Th>
                        <Th className="text-right">IGST</Th>
                        <Th className="text-right">CGST</Th>
                        <Th className="text-right">SGST</Th>
                        <Th className="text-right">Cess</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.gstr1.b2cs.map((b) => (
                        <tr key={`${b.sply_ty}-${b.pos}-${b.rt}`}>
                          <Td>{b.sply_ty}</Td>
                          <Td>{b.pos}</Td>
                          <Td>{b.typ}</Td>
                          <Td className="tabular text-right font-semibold">{b.rt}%</Td>
                          <Td className="tabular text-right font-bold">{rs(b.txval)}</Td>
                          <Td className="tabular text-right">{rs(b.iamt)}</Td>
                          <Td className="tabular text-right">{rs(b.camt)}</Td>
                          <Td className="tabular text-right">{rs(b.samt)}</Td>
                          <Td className="tabular text-right">{rs(b.csamt)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Section>

              <Section title="HSN summary">
                {r.gstr1.hsn.data.length === 0 ? (
                  <EmptyState title="No HSN lines" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <Th>HSN/SAC</Th>
                        <Th>Description</Th>
                        <Th>UQC</Th>
                        <Th className="text-right">Qty</Th>
                        <Th className="text-right">Rate</Th>
                        <Th className="text-right">Taxable value</Th>
                        <Th className="text-right">IGST</Th>
                        <Th className="text-right">CGST</Th>
                        <Th className="text-right">SGST</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.gstr1.hsn.data.map((h) => (
                        <tr key={h.num}>
                          <Td className="font-mono font-semibold">{h.hsn_sc}</Td>
                          <Td>{h.desc}</Td>
                          <Td>{h.uqc}</Td>
                          <Td className="tabular text-right">{fmtInt(h.qty)}</Td>
                          <Td className="tabular text-right">{h.rt}%</Td>
                          <Td className="tabular text-right font-bold">{rs(h.txval)}</Td>
                          <Td className="tabular text-right">{rs(h.iamt)}</Td>
                          <Td className="tabular text-right">{rs(h.camt)}</Td>
                          <Td className="tabular text-right">{rs(h.samt)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Section>

              <Section title="Documents issued" subtitle="Invoice series ranges (Table 13)">
                {r.gstr1.doc_issue.doc_det.length === 0 ? (
                  <EmptyState title="No documents issued" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <Th>Nature of document</Th>
                        <Th>From</Th>
                        <Th>To</Th>
                        <Th className="text-right">Total</Th>
                        <Th className="text-right">Cancelled</Th>
                        <Th className="text-right">Net issued</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.gstr1.doc_issue.doc_det.flatMap((d) =>
                        d.docs.map((x) => (
                          <tr key={`${d.doc_num}-${x.num}`}>
                            <Td className="font-semibold">{d.doc_typ}</Td>
                            <Td className="font-mono text-xs">{x.from}</Td>
                            <Td className="font-mono text-xs">{x.to}</Td>
                            <Td className="tabular text-right">{fmtInt(x.totnum)}</Td>
                            <Td className="tabular text-right">{fmtInt(x.cancel)}</Td>
                            <Td className="tabular text-right font-bold">{fmtInt(x.net_issue)}</Td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </Table>
                )}
              </Section>

              <Notes notes={r.notes} />
            </div>
          )}
        </ReportBody>
      )}
    </>
  );
}
