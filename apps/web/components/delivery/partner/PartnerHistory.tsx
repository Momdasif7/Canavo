"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Delivery } from "@/lib/types-service";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Td, Th, Tr } from "@/components/ui/Table";
import { paidHow, paidHowLabel, type PaidHow } from "../common";
import { PeriodChips, usePeriod } from "./period";

/** Short area for the list: landmark, else the last meaningful part of the address. */
function area(d: Delivery): string {
  if (d.landmark) return d.landmark;
  const parts = d.address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] ?? parts[0] : parts[0] ?? "";
}

interface Row {
  d: Delivery;
  how: PaidHow;
  when: string;
}

export function PartnerHistory() {
  const { outletId, me } = useSession();
  const { period, today, choose, setRange } = usePeriod("last7");
  const [search, setSearch] = useState("");
  const q = useApiQuery<Delivery[]>(outletId ? `partner-history:${outletId}:${period.from}:${period.to}` : null, () =>
    api.get<Delivery[]>("/delivery/mine", { query: { view: "history", from: period.from, to: period.to } }),
  );
  useSocketEvent("delivery:updated", () => void q.reload());

  const rows = useMemo<Row[]>(() => {
    const term = search.trim().toLowerCase();
    return (q.data ?? [])
      .filter((d) => !term || d.order.invoiceNumber.toLowerCase().includes(term) || d.customerName.toLowerCase().includes(term) || d.customerPhone.includes(term))
      .map((d) => ({ d, how: paidHow(d, me?.id ?? ""), when: d.deliveredAt ?? d.updatedAt }));
  }, [q.data, search, me?.id]);

  const totals = useMemo(() => {
    const delivered = rows.filter((r) => r.d.status === "DELIVERED");
    const sum = (k: keyof Omit<PaidHow, "references">) => delivered.reduce((s, r) => s + r.how[k], 0);
    return {
      delivered: delivered.length,
      cancelled: rows.length - delivered.length,
      value: delivered.reduce((s, r) => s + r.d.order.grandTotal, 0),
      cash: sum("cash"),
      upi: sum("upi"),
      card: sum("card"),
      prepaid: sum("prepaid"),
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <PeriodChips presets={["today", "yesterday", "last7", "month", "custom"]} period={period} today={today} onChoose={choose} onRange={setRange} />
      <Input
        aria-label="Search by invoice or customer"
        placeholder="Search invoice or customer"
        prefix={<MagnifyingGlass size={18} />}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        type="search"
      />
      {q.loading && !q.data ? (
        <LoadingState label="Loading history…" />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !rows.length ? (
        <Card>
          <EmptyState title={search ? "No matching deliveries" : "No deliveries in this period"} description={search ? "Try another invoice number or name." : "Pick a longer period above."} />
        </Card>
      ) : (
        <>
          {/* Totals */}
          <Card className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6" data-testid="history-totals">
            <TotalCell label="Delivered" value={`${totals.delivered}${totals.cancelled ? ` (+${totals.cancelled} cancelled)` : ""}`} />
            <TotalCell label="Order value" value={formatINR(totals.value)} />
            <TotalCell label="Cash" value={formatINR(totals.cash)} />
            <TotalCell label="UPI" value={formatINR(totals.upi)} />
            <TotalCell label="Card" value={formatINR(totals.card)} />
            <TotalCell label="Prepaid" value={formatINR(totals.prepaid)} />
          </Card>

          {/* Phone: cards */}
          <ul className="space-y-2 md:hidden" aria-label="Deliveries">
            {rows.map(({ d, how, when }) => (
              <li key={d.id} className="rounded-2xl border border-line bg-surface p-3 shadow-sm" data-testid="history-row">
                <div className="flex items-center gap-2">
                  <strong className="font-mono">{d.order.invoiceNumber}</strong>
                  <StatusBadge d={d} />
                  <span className="tabular ml-auto font-bold">{formatINR(d.order.grandTotal)}</span>
                </div>
                <p className="mt-1 font-semibold">{d.customerName}</p>
                <p className="text-sm text-muted">
                  {area(d)} · {formatDateTime(when)}
                </p>
                {d.status === "DELIVERED" && <PaidCell how={how} />}
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <THead>
                <tr>
                  <Th>Delivered</Th>
                  <Th>Invoice</Th>
                  <Th>Customer</Th>
                  <Th>Area</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Order value</Th>
                  <Th>How it was paid</Th>
                </tr>
              </THead>
              <tbody>
                {rows.map(({ d, how, when }) => (
                  <Tr key={d.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(when)}</Td>
                    <Td className="font-mono font-semibold">{d.order.invoiceNumber}</Td>
                    <Td>{d.customerName}</Td>
                    <Td className="max-w-[220px] truncate text-muted" title={d.address}>
                      {area(d)}
                    </Td>
                    <Td>
                      <StatusBadge d={d} />
                    </Td>
                    <Td className="tabular text-right font-semibold">{formatINR(d.order.grandTotal)}</Td>
                    <Td>{d.status === "DELIVERED" ? <PaidCell how={how} /> : <span className="text-muted">—</span>}</Td>
                  </Tr>
                ))}
                <tr className="border-t-2 border-line bg-surface-2 font-bold">
                  <Td colSpan={5}>
                    Total · {totals.delivered} delivered{totals.cancelled ? `, ${totals.cancelled} cancelled` : ""}
                  </Td>
                  <Td className="tabular text-right">{formatINR(totals.value)}</Td>
                  <Td className="text-sm">
                    Cash {formatINR(totals.cash)} · UPI {formatINR(totals.upi)} · Card {formatINR(totals.card)} · Prepaid {formatINR(totals.prepaid)}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

function TotalCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="tabular font-extrabold">{value}</p>
    </div>
  );
}

function StatusBadge({ d }: { d: Delivery }) {
  return d.status === "DELIVERED" ? <Badge tone="success">Delivered</Badge> : <Badge tone="danger">Cancelled</Badge>;
}

function PaidCell({ how }: { how: PaidHow }) {
  return (
    <p className={clsx("mt-1 text-sm font-semibold md:mt-0", how.cash > 0 && "text-primary-700 dark:text-primary-200")} data-testid="paid-how">
      {paidHowLabel(how)}
      {how.references.length > 0 && <span className="ml-1 font-normal text-muted">(UTR/ref {how.references.join(", ")})</span>}
    </p>
  );
}
