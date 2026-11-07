"use client";

import { useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/layout/PageHeader";
import { Kpi, KpiGrid, ReportBody, Section } from "@/components/reports/shared";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { useReportRange } from "@/components/reports/range";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Input";
import { Alert, EmptyState } from "@/components/ui/States";

interface Settlements {
  from: string;
  to: string;
  byMode: Record<"CARD" | "UPI", { expected: { count: number; amount: number }; settled: { count: number; amount: number } }>;
  pending: { id: string; mode: string; amount: number; reference: string | null; cardLast4: string | null; authCode: string | null; createdAt: string; invoiceNumber: string }[];
}

/**
 * Reports → Settlements (Phase 3.8): paste the bank / card-machine settlement rows
 * (date, amount, reference) and see which card / UPI payments haven't reached the bank.
 */
export default function SettlementsPage() {
  const { from, to } = useReportRange().range;
  const { can } = useSession();
  const data = useApiQuery<Settlements>(`settlements:${from}:${to}`, () => api.get<Settlements>("/settlements", { query: { from, to } }));
  const [mode, setMode] = useState<"CARD" | "UPI">("CARD");
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** "2026-11-01, 1234.50, REF123" per line (CSV or tab separated; header lines are skipped). */
  const parseRows = () =>
    text
      .split(/\r?\n/)
      .map((l) => l.split(/[,\t;]/).map((c) => c.trim()))
      .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0] ?? "") && !Number.isNaN(Number(c[1])))
      .map((c) => ({ date: c[0]!, amount: Math.round(Number(c[1]) * 100), reference: c[2] || undefined }));

  const upload = async () => {
    const rows = parseRows();
    if (!rows.length) return setError("No rows found. Use one line per payment: date (YYYY-MM-DD), amount in ₹, reference.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ matched: unknown[]; unmatched: { row: number }[] }>("/settlements", { mode, rows });
      setResult(`${r.matched.length} matched, ${r.unmatched.length} not found${r.unmatched.length ? ` (rows ${r.unmatched.map((u) => u.row).join(", ")})` : ""}.`);
      setText("");
      await data.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settlements" subtitle="Check that card and UPI money reached your bank." />
      <ReportToolbar exports={[]} />
      <ReportBody state={data}>
        {(r) => (
          <div className="space-y-5">
            <KpiGrid>
              {(["CARD", "UPI"] as const).map((m) => (
                <Kpi
                  key={m}
                  label={`${m === "CARD" ? "Card" : "UPI"} settled`}
                  value={`${formatINR(r.byMode[m].settled.amount)}`}
                  note={`of ${formatINR(r.byMode[m].expected.amount)} · ${r.byMode[m].expected.count - r.byMode[m].settled.count} pending`}
                />
              ))}
            </KpiGrid>
            {can("settlement:manage") && (
              <Section title="Upload a settlement file" subtitle="Paste rows from the bank or card-machine report: date, amount (₹), reference (approval code / UTR).">
                <div className="space-y-3 p-4">
                  {error && <Alert>{error}</Alert>}
                  {result && <Alert tone="info">{result}</Alert>}
                  <Select label="Payments of" value={mode} onChange={(e) => setMode(e.target.value as "CARD" | "UPI")} wrapperClassName="max-w-[200px]">
                    <option value="CARD">Card</option>
                    <option value="UPI">UPI</option>
                  </Select>
                  <Textarea label="Rows" rows={6} placeholder={"2026-11-01, 1250.00, AB12CD\n2026-11-01, 380, 998877"} value={text} onChange={(e) => setText(e.target.value)} />
                  <Button icon={<UploadSimple size={20} />} loading={busy} disabled={!text.trim()} onClick={() => void upload()}>
                    Match
                  </Button>
                </div>
              </Section>
            )}
            <Section title="Not settled yet">
              {r.pending.length === 0 ? (
                <EmptyState title="Everything in this period is settled" />
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {r.pending.map((p) => (
                    <li key={p.id} className="flex flex-wrap gap-3 px-4 py-2">
                      <span className="font-semibold">{p.invoiceNumber}</span>
                      <span className="text-muted">
                        {formatDateTime(p.createdAt)} · {p.mode}
                        {p.cardLast4 && ` ····${p.cardLast4}`}
                        {(p.authCode ?? p.reference) && ` · ${p.authCode ?? p.reference}`}
                      </span>
                      <span className="tabular ml-auto">{formatINR(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </ReportBody>
    </>
  );
}
