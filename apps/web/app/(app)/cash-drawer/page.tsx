"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, LockKey, LockOpen, Printer } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useApproval } from "@/components/providers/ApprovalProvider";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

interface Summary {
  from: string;
  to: string;
  openingFloat: number;
  bills: { count: number; gross: number; discounts: number; tax: number };
  voids: { count: number; amount: number };
  payments: Record<string, { count: number; amount: number }>;
  counterCash: number;
  cashTips?: number;
  giftCardCashSales?: number;
  deliveryCashHandedOver: number;
  refunds: Record<string, { count: number; amount: number }>;
  cashRefunds: number;
  payIns: number;
  payOuts: number;
  expectedCash: number;
}
interface Movement {
  id: string;
  type: "PAY_IN" | "PAY_OUT";
  amount: number;
  reason: string;
  createdAt: string;
}
interface Shift {
  id: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  countedCash: number | null;
  expectedCash: number | null;
  variance: number | null;
  note: string | null;
  movements?: Movement[];
  summary: Summary;
}

const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
const rupees = (s: string) => Math.round(Number(s || 0) * 100);

/** Billing → Cash drawer (Phase 3.2): open with a float, pay-ins / outs, close with a count → Z-report. */
export default function CashDrawerPage() {
  const toast = useToast();
  const { can } = useSession();
  const withApproval = useApproval();
  const current = useApiQuery<Shift | null>("cash-shift-current", () => api.get<Shift | null>("/cash-shifts/current"));
  const history = useApiQuery<Shift[]>(can("report:view") ? "cash-shifts" : null, () => api.get<Shift[]>("/cash-shifts", { query: { limit: 15 } }));
  const [float, setFloat] = useState("");
  const [move, setMove] = useState<{ type: "PAY_IN" | "PAY_OUT"; amount: string; reason: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zReport, setZReport] = useState<Shift | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const countedFromDenoms = DENOMS.reduce((s, d) => s + d * 100 * Number(counts[d] || 0), 0);
  const countedPaise = counted !== "" ? rupees(counted) : countedFromDenoms;
  const s = current.data;

  return (
    <PageContainer>
      <PageHeader title="Cash drawer" subtitle="Count the float when you start, record cash in and out, and count again at the end of the shift." />
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {current.loading && current.data === undefined ? (
        <LoadingState />
      ) : current.error ? (
        <ErrorState message={current.error} onRetry={current.reload} />
      ) : !s ? (
        <Card className="max-w-lg">
          <CardHeader title="No shift open" subtitle="Count the cash in the drawer to start." />
          <div className="space-y-4 p-5">
            <Input label="Opening float (₹)" type="number" min={0} step="1" value={float} onChange={(e) => setFloat(e.target.value)} />
            <Button
              icon={<LockOpen size={20} />}
              loading={busy}
              disabled={float === ""}
              onClick={() =>
                void run(async () => {
                  await api.post("/cash-shifts/open", { openingFloat: rupees(float) });
                  setFloat("");
                  toast("Cash shift opened", "success");
                  await current.reload();
                })
              }
            >
              Open shift
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Card>
            <CardHeader title={<span className="flex items-center gap-2">Shift open <Badge tone="success">since {formatDateTime(s.openedAt)}</Badge></span>} subtitle="Live figures (X-report)" />
            <SummaryTable summary={s.summary} />
          </Card>
          <div className="space-y-5">
            <Card>
              <CardHeader title="Cash in / out" />
              <div className="flex gap-2 p-5">
                <Button variant="outline" icon={<ArrowDown size={20} />} onClick={() => setMove({ type: "PAY_IN", amount: "", reason: "" })}>
                  Pay in
                </Button>
                <Button variant="outline" icon={<ArrowUp size={20} />} onClick={() => setMove({ type: "PAY_OUT", amount: "", reason: "" })}>
                  Pay out
                </Button>
              </div>
              {(s.movements ?? []).length > 0 && (
                <ul className="divide-y divide-line border-t border-line text-sm">
                  {s.movements!.map((m) => (
                    <li key={m.id} className="flex justify-between px-5 py-2">
                      <span>
                        {m.type === "PAY_IN" ? "In" : "Out"} · {m.reason}
                      </span>
                      <span className={m.type === "PAY_IN" ? "tabular font-semibold" : "tabular font-semibold text-red-600 dark:text-red-300"}>
                        {m.type === "PAY_IN" ? "+" : "−"}
                        {formatINR(m.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Button block size="lg" variant="danger" icon={<LockKey size={20} />} onClick={() => setClosing(true)}>
              Close shift
            </Button>
          </div>
        </div>
      )}

      {history.data && history.data.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Past shifts" />
          <ul className="divide-y divide-line text-sm">
            {history.data.filter((h) => h.status === "CLOSED").map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 px-5 py-2">
                <span className="min-w-0 flex-1">
                  {formatDateTime(h.openedAt)} → {h.closedAt ? formatDateTime(h.closedAt) : ""}
                </span>
                <span className="tabular">Expected {formatINR(h.expectedCash ?? 0)}</span>
                <Badge tone={(h.variance ?? 0) === 0 ? "success" : (h.variance ?? 0) < 0 ? "danger" : "warning"}>
                  {(h.variance ?? 0) === 0 ? "Exact" : `${(h.variance ?? 0) < 0 ? "Short" : "Over"} ${formatINR(Math.abs(h.variance ?? 0))}`}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => void api.get<Shift>(`/cash-shifts/${h.id}`).then(setZReport)}>
                  Z-report
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {history.data?.length === 0 && !s && <EmptyState title="No shifts yet" />}

      <Dialog
        open={move !== null}
        onClose={() => setMove(null)}
        size="sm"
        title={move?.type === "PAY_IN" ? "Pay cash in" : "Pay cash out"}
        footer={
          <Button
            loading={busy}
            disabled={!move || !Number(move.amount) || move.reason.trim().length < 3}
            onClick={() =>
              void run(async () => {
                const body = { type: move!.type, amount: rupees(move!.amount), reason: move!.reason.trim() };
                await withApproval((approval) => api.post("/cash-shifts/current/movements", { ...body, approval }));
                setMove(null);
                await current.reload();
              })
            }
          >
            Save
          </Button>
        }
      >
        {move && (
          <div className="space-y-4">
            <Input label="Amount (₹)" type="number" min={1} value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} />
            <Input label="Reason" placeholder={move.type === "PAY_IN" ? "e.g. Change from bank" : "e.g. Milk supplier paid in cash"} maxLength={200} value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} />
          </div>
        )}
      </Dialog>

      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        title="Close shift"
        description="Count the cash in the drawer. Use the note counter or type the total."
        footer={
          <Button
            variant="danger"
            loading={busy}
            disabled={countedPaise < 0 || (counted === "" && countedFromDenoms === 0)}
            onClick={() =>
              void run(async () => {
                const denominations = Object.fromEntries(Object.entries(counts).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
                const closed = await api.post<Shift>("/cash-shifts/current/close", { countedCash: countedPaise, denominations, note: note.trim() || undefined });
                setClosing(false);
                setCounts({});
                setCounted("");
                setNote("");
                setZReport(closed);
                await current.reload();
                await history.reload();
              })
            }
          >
            Close and print Z-report
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {DENOMS.map((d) => (
              <Input key={d} label={`₹${d} ×`} type="number" min={0} value={counts[d] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))} />
            ))}
          </div>
          <Input label="Or total counted (₹)" type="number" min={0} value={counted} onChange={(e) => setCounted(e.target.value)} hint={`Counted: ${formatINR(countedPaise)}`} />
          <Input label="Note (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Dialog>

      <Dialog
        open={zReport !== null}
        onClose={() => setZReport(null)}
        title="Z-report"
        description={zReport ? `${formatDateTime(zReport.openedAt)} → ${zReport.closedAt ? formatDateTime(zReport.closedAt) : "now"}` : undefined}
        footer={
          <Button icon={<Printer size={20} />} onClick={() => window.print()}>
            Print
          </Button>
        }
      >
        {zReport && (
          <div className="space-y-3">
            <SummaryTable summary={zReport.summary} />
            <dl className="tabular space-y-1 border-t border-line pt-3 text-sm">
              <Row label="Counted cash" value={formatINR(zReport.countedCash ?? 0)} strong />
              <Row
                label="Difference"
                value={(zReport.variance ?? 0) === 0 ? "Exact" : `${(zReport.variance ?? 0) < 0 ? "Short" : "Over"} ${formatINR(Math.abs(zReport.variance ?? 0))}`}
                strong
              />
              {zReport.note && <Row label="Note" value={zReport.note} />}
            </dl>
          </div>
        )}
      </Dialog>
    </PageContainer>
  );
}

function SummaryTable({ summary: m }: { summary: Summary }) {
  return (
    <dl className="tabular space-y-1 p-5 text-sm">
      <Row label={`Paid bills (${m.bills.count})`} value={formatINR(m.bills.gross)} />
      <Row label="Discounts given" value={formatINR(m.bills.discounts)} />
      <Row label="Tax collected" value={formatINR(m.bills.tax)} />
      <Row label={`Voids (${m.voids.count})`} value={formatINR(m.voids.amount)} />
      {Object.entries(m.payments).map(([mode, p]) => (
        <Row key={mode} label={`${mode} payments (${p.count})`} value={formatINR(p.amount)} />
      ))}
      {Object.entries(m.refunds).map(([mode, r]) => (
        <Row key={mode} label={`${mode} refunds (${r.count})`} value={`−${formatINR(r.amount)}`} />
      ))}
      <div className="my-2 border-t border-line" />
      <Row label="Opening float" value={formatINR(m.openingFloat)} />
      <Row label="+ Cash sales at the counter" value={formatINR(m.counterCash)} />
      {(m.cashTips ?? 0) > 0 && <Row label="+ Cash tips" value={formatINR(m.cashTips!)} />}
      {(m.giftCardCashSales ?? 0) > 0 && <Row label="+ Gift cards sold for cash" value={formatINR(m.giftCardCashSales!)} />}
      {m.deliveryCashHandedOver > 0 && <Row label="+ Delivery cash handed over" value={formatINR(m.deliveryCashHandedOver)} />}
      {m.payIns > 0 && <Row label="+ Pay-ins" value={formatINR(m.payIns)} />}
      {m.payOuts > 0 && <Row label="− Pay-outs" value={formatINR(m.payOuts)} />}
      {m.cashRefunds > 0 && <Row label="− Cash refunds" value={formatINR(m.cashRefunds)} />}
      <Row label="Expected in drawer" value={formatINR(m.expectedCash)} strong />
    </dl>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between font-bold" : "flex justify-between"}>
      <dt className={strong ? "" : "text-muted"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
